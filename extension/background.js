// Session Handoff — extension service worker (spec §7, §13).
//
// Holds one pairing, keeps a WebSocket to the relay, turns `needs_session`
// into a badge + notification, and on "Done" exports cookies + localStorage
// for the requested origins and sends an encrypted `session_bundle`.

/* global HandoffCommon */
importScripts('lib/nacl-fast.min.js', 'lib/common.js');
const C = self.HandoffCommon;

const DEFAULT_RELAY = 'http://127.0.0.1:8787';
// Hardcoded MVP denylist (spec §13): identity-provider account management.
const DENYLIST = ['accounts.google.com', 'login.microsoftonline.com', 'www.paypal.com'];
const KEEPALIVE_ALARM = 'handoff-keepalive';
const WS_PING_MS = 20_000;
const MAX_LOG = 50;
const MAX_SEEN = 300;
const SAMESITE = { no_restriction: 'None', lax: 'Lax', strict: 'Strict', unspecified: 'Lax' };

// ---------------------------------------------------------------- storage

const store = {
  async get(key, fallback) {
    const r = await chrome.storage.local.get(key);
    return r[key] === undefined ? fallback : r[key];
  },
  set(obj) {
    return chrome.storage.local.set(obj);
  },
};

async function getIdentity() {
  let identity = await store.get('identity');
  if (!identity) {
    identity = C.generateIdentity();
    await store.set({ identity });
  }
  return identity;
}

const getPairing = () => store.get('pairing', null);
const getRequests = () => store.get('requests', {});

async function setRequests(requests) {
  await store.set({ requests });
  await updateBadge(requests);
}

async function setConn(state, extra = {}) {
  await store.set({ conn: { state, at: Date.now(), ...extra } });
}

async function appendLog(entry) {
  const log = await store.get('log', []);
  log.unshift({ at: Date.now(), ...entry });
  await store.set({ log: log.slice(0, MAX_LOG) });
}

async function updateBadge(requests) {
  const n = Object.values(requests || (await getRequests())).filter((r) => r.state === 'pending' || r.state === 'started').length;
  await chrome.action.setBadgeText({ text: n ? String(n) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#d97706' });
}

// ---------------------------------------------------------------- relay transport

let ws = null;
let backoffMs = 1000;
let reconnectTimer = null;
let pingTimer = null;
let connectInFlight = null;

function stopPing() {
  clearInterval(pingTimer);
  pingTimer = null;
}

// Reentrant-safe: the service worker may call this from several events at once
// (top-level boot, onStartup, alarms); only one socket may exist per worker.
function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return Promise.resolve();
  if (connectInFlight) return connectInFlight;
  connectInFlight = doConnect().finally(() => { connectInFlight = null; });
  return connectInFlight;
}

async function doConnect() {
  const pairing = await getPairing();
  if (!pairing || pairing.revoked) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(reconnectTimer);
  await setConn('connecting');
  let sock;
  try {
    sock = new WebSocket(pairing.relay_ws);
  } catch (e) {
    await setConn('offline', { error: e.message });
    scheduleReconnect();
    return;
  }
  ws = sock;
  sock.onopen = () => sock.send(JSON.stringify({ type: 'auth', token: pairing.token }));
  sock.onmessage = (ev) => {
    if (ws !== sock) return; // superseded socket
    handleWsFrame(sock, ev.data).catch((e) => console.error('[handoff] ws frame error', e));
  };
  sock.onerror = () => { /* onclose follows */ };
  sock.onclose = async (ev) => {
    if (ws !== sock) return; // a newer socket owns the connection state
    ws = null;
    stopPing();
    if (ev.code === 4001) {
      await markRevoked(ev.reason || 'unpaired');
      return;
    }
    await setConn('offline', { code: ev.code, reason: ev.reason });
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => connect(), backoffMs);
  backoffMs = Math.min(backoffMs * 2, 60_000);
}

async function markRevoked(reason) {
  const pairing = await getPairing();
  if (pairing) await store.set({ pairing: { ...pairing, revoked: true, revoked_at: Date.now() } });
  await setConn('revoked', { reason });
  await appendLog({ kind: 'revoked', text: `Pairing revoked (${reason})` });
  await setRequests({});
  await clearProxy();
}

async function handleWsFrame(sock, data) {
  let msg;
  try { msg = JSON.parse(data); } catch { return; }
  switch (msg.type) {
    case 'ready':
      backoffMs = 1000;
      await setConn('online');
      stopPing();
      pingTimer = setInterval(() => {
        if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: 'ping' }));
      }, WS_PING_MS);
      break;
    case 'message':
      await handleEnvelope(msg.envelope);
      if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: 'ack', msg_id: msg.envelope.msg_id }));
      break;
    case 'revoked':
      await markRevoked('revoked');
      break;
    case 'pong':
    case 'sent':
      break;
    case 'error':
      console.warn('[handoff] relay error', msg);
      if (msg.error === 'unpaired') await markRevoked('unpaired');
      break;
    default:
      break;
  }
}

async function sendToAgent(type, payload) {
  const pairing = await getPairing();
  if (!pairing || pairing.revoked) throw new Error('not paired');
  const envelope = C.makeEnvelope({ pairing_id: pairing.pairing_id, type, payload, recipientPkB64: pairing.agent.agent_enc_pk });
  const res = await fetch(`${pairing.relay_http}/v1/pairings/${pairing.pairing_id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${pairing.token}` },
    body: JSON.stringify(envelope),
  });
  if (res.status === 401 || res.status === 404 || res.status === 410) {
    await markRevoked('unpaired');
    throw new Error('pairing was revoked');
  }
  if (!res.ok) throw new Error(`relay rejected message (${res.status})`);
  return envelope.msg_id;
}

// ---------------------------------------------------------------- inbound messages

async function alreadySeen(msgId) {
  const seen = await store.get('seen', []);
  if (seen.includes(msgId)) return true;
  seen.push(msgId);
  await store.set({ seen: seen.slice(-MAX_SEEN) });
  return false;
}

function originsKey(origins) {
  return [...origins].map((o) => o.toLowerCase()).sort().join(',');
}

function denylisted(origins) {
  return origins.filter((o) => {
    try {
      const h = new URL(o).hostname;
      return DENYLIST.some((d) => h === d || h.endsWith('.' + d));
    } catch {
      return true;
    }
  });
}

async function handleEnvelope(env) {
  if (!env || env.from !== 'agent') return;
  if (await alreadySeen(env.msg_id)) return;
  const identity = await getIdentity();
  let payload;
  try {
    payload = C.open(env.payload, identity.enc_sk);
  } catch (e) {
    await appendLog({ kind: 'error', text: `Could not decrypt ${env.type} (${e.message})` });
    return;
  }
  switch (env.type) {
    case 'needs_session':
      return onNeedsSession(payload);
    case 'report':
      return onReport(payload);
    case 'revoke_session':
      await appendLog({ kind: 'revoke_session', text: `Agent asks you to log out of ${(payload.origins || []).join(', ')}` });
      return;
    default:
      await appendLog({ kind: 'error', text: `Unknown message type ${env.type}` });
  }
}

async function onNeedsSession(p) {
  if (!p || typeof p.request_id !== 'string' || !Array.isArray(p.origins) || !p.origins.length) return;
  const now = Math.floor(Date.now() / 1000);
  if (typeof p.expires_at === 'number' && p.expires_at <= now) {
    await appendLog({ kind: 'stale', request_id: p.request_id, text: `Ignored expired request for ${p.origins.join(', ')}` });
    return;
  }
  const blocked = denylisted(p.origins);
  if (blocked.length) {
    await sendToAgent('declined', { request_id: p.request_id, reason: 'denylist' });
    await appendLog({ kind: 'denylist', request_id: p.request_id, origins: p.origins, text: `Declined (denylist): ${blocked.join(', ')}` });
    return;
  }
  const requests = await getRequests();
  const key = originsKey(p.origins);
  // Idempotency (spec §5.2): an identical unanswered request replaces the old one.
  for (const [id, r] of Object.entries(requests)) {
    if ((r.state === 'pending' || r.state === 'started') && (id === p.request_id || originsKey(r.origins) === key)) {
      if (id === p.request_id) {
        requests[id] = { ...r, hint_url: p.hint_url, task_label: p.task_label, expires_at: p.expires_at };
        await setRequests(requests);
        return; // resumed by the CLI; keep the existing badge/state
      }
      delete requests[id];
    }
  }
  requests[p.request_id] = {
    request_id: p.request_id,
    origins: p.origins,
    tier: p.tier || 1,
    hint_url: p.hint_url || p.origins[0] + '/',
    task_label: p.task_label || 'Agent needs a session',
    expires_at: p.expires_at,
    allow_silent: Boolean(p.allow_silent),
    state: 'pending',
    received_at: Date.now(),
  };
  await setRequests(requests);
  await appendLog({ kind: 'request', request_id: p.request_id, origins: p.origins, text: `Session requested: ${p.task_label || ''} (${p.origins.join(', ')})` });
  const pairing = await getPairing();
  notify(p.request_id, `${pairing?.agent?.display_name || 'Agent'} needs a session`, `${p.task_label || ''}\n${p.origins.join(', ')}`);
  // Pop a compact window so the human sees Start / Done / Decline without hunting
  // for the toolbar icon. Chrome can't reliably open the action popup on a
  // background event, but it can open a window (spec §7 interactive path).
  await openRequestWindow();
}

async function onReport(p) {
  if (!p || typeof p.request_id !== 'string') return;
  const requests = await getRequests();
  const r = requests[p.request_id];
  if (r) {
    requests[p.request_id] = { ...r, state: 'reported', result: { ok: Boolean(p.ok), reason: p.reason || null, at: Date.now() } };
    await setRequests(requests);
  }
  const text = p.ok ? 'Agent reports the session worked' : `Agent reports failure: ${p.reason || 'unspecified'}`;
  await appendLog({ kind: 'report', request_id: p.request_id, origins: r?.origins, ok: Boolean(p.ok), text });
  notify(`report-${p.request_id}`, p.ok ? '✓ Session handoff worked' : '✗ Session handoff failed', p.ok ? (r?.origins || []).join(', ') : p.reason || 'unspecified');
}

function notify(id, title, message) {
  try {
    chrome.notifications.create(id, { type: 'basic', iconUrl: 'icon.png', title, message: message.slice(0, 400) }, () => void chrome.runtime.lastError);
  } catch { /* notifications unavailable */ }
}

chrome.notifications.onClicked.addListener(async (id) => {
  chrome.notifications.clear(id);
  await openRequestWindow();
});

// ---------------------------------------------------------------- request window

// A single reused popup window. windows.create can fire from a background event
// (unlike chrome.action.openPopup, which needs a focused Chrome window), so this
// is the reliable way to surface a request. Serialized so two fast requests don't
// race into two windows; the window id is persisted so a restarted service worker
// still finds it.
let windowOpLock = Promise.resolve();

function openRequestWindow() {
  windowOpLock = windowOpLock.catch(() => {}).then(doOpenRequestWindow);
  return windowOpLock;
}

async function doOpenRequestWindow() {
  const existing = await store.get('requestWindowId', null);
  if (existing != null) {
    try {
      await chrome.windows.update(existing, { focused: true, drawAttention: true });
      return existing;
    } catch { /* window was closed; fall through and create a new one */ }
  }
  try {
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL('popup.html?window=1'),
      type: 'popup',
      width: 400,
      height: 640,
      focused: true,
    });
    await store.set({ requestWindowId: win.id });
    return win.id;
  } catch (e) {
    console.warn('[handoff] could not open request window', e);
    return null;
  }
}

chrome.windows.onRemoved.addListener(async (winId) => {
  if ((await store.get('requestWindowId', null)) === winId) await chrome.storage.local.remove('requestWindowId');
});

// ---------------------------------------------------------------- tier-2 proxy (spec §7 PAC)
//
// For a tier-2 request the human's login must egress from the relay, so we route
// only the requested origins' hosts (and their parents) through the relay proxy
// with a PAC, answer the proxy's Basic auth challenge, and clear it when done.

let proxyAuthActive = null; // { server, username, password } while a PAC is applied

function pacScript(hosts, proxyServer) {
  // proxyServer is "host:port"; DIRECT for everything else.
  const list = JSON.stringify(hosts.map((h) => h.toLowerCase()));
  return `function FindProxyForURL(url, host) {
  var hosts = ${list};
  host = host.toLowerCase();
  for (var i = 0; i < hosts.length; i++) {
    if (host === hosts[i] || host.indexOf('.' + hosts[i]) === (host.length - hosts[i].length - 1)) {
      return 'PROXY ${proxyServer}';
    }
  }
  return 'DIRECT';
}`;
}

async function applyProxy(origins) {
  const pairing = await getPairing();
  if (!pairing?.proxy) throw new Error('no proxy credentials for this pairing');
  const hosts = [...new Set(origins.map((o) => { try { return new URL(o).hostname; } catch { return null; } }).filter(Boolean))];
  const config = { mode: 'pac_script', pacScript: { data: pacScript(hosts, pairing.proxy.server) } };
  await chrome.proxy.settings.set({ value: config, scope: 'regular' });
  proxyAuthActive = { ...pairing.proxy };
  await store.set({ activeProxy: { hosts, server: pairing.proxy.server, at: Date.now() } });
}

async function clearProxy() {
  proxyAuthActive = null;
  await chrome.storage.local.remove('activeProxy');
  try { await chrome.proxy.settings.clear({ scope: 'regular' }); } catch { /* nothing set */ }
}

// Answer the relay proxy's 407 with the per-pairing credentials (MV3 async blocking).
chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    if (details.isProxy && proxyAuthActive) {
      callback({ authCredentials: { username: proxyAuthActive.username, password: proxyAuthActive.password } });
    } else if (callback) {
      callback({});
    }
  },
  { urls: ['<all_urls>'] },
  ['asyncBlocking'],
);

// After a restart, re-assert proxyAuthActive from storage so auth still answers.
store.get('activeProxy', null).then(async (ap) => {
  if (!ap) return;
  const pairing = await getPairing();
  if (pairing?.proxy) proxyAuthActive = { ...pairing.proxy };
});

// ---------------------------------------------------------------- export (spec §6)

function domainCandidates(host) {
  if (/^[\d.]+$/.test(host) || /^\[.*\]$/.test(host) || !host.includes('.')) return [host];
  const labels = host.split('.');
  const out = [];
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join('.'));
  return out;
}

function cookieMatchesHost(cookie, host) {
  const d = cookie.domain.replace(/^\./, '').toLowerCase();
  return host === d || host.endsWith('.' + d);
}

function toBundleCookie(c) {
  let sameSite = SAMESITE[c.sameSite] || 'Lax';
  if (sameSite === 'None' && !c.secure) sameSite = 'Lax';
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.session || !c.expirationDate ? -1 : c.expirationDate,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite,
  };
}

async function collectCookies(origins) {
  const byKey = new Map();
  for (const origin of origins) {
    const host = new URL(origin).hostname.toLowerCase();
    const found = [];
    for (const domain of domainCandidates(host)) {
      try { found.push(...(await chrome.cookies.getAll({ domain }))); } catch (e) { console.warn('[handoff] cookies.getAll', domain, e); }
    }
    try { found.push(...(await chrome.cookies.getAll({ url: origin + '/' }))); } catch { /* ignore */ }
    for (const c of found) {
      if (!cookieMatchesHost(c, host)) continue;
      byKey.set(`${c.name}|${c.domain}|${c.path}`, toBundleCookie(c));
    }
  }
  return [...byKey.values()];
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = async () => {
      try {
        const t = await chrome.tabs.get(tabId);
        if (t.status === 'complete') return resolve(true);
      } catch {
        return resolve(false);
      }
      if (Date.now() - started > timeoutMs) return resolve(false);
      setTimeout(tick, 250);
    };
    tick();
  });
}

async function readLocalStorage(origin) {
  const tabs = await chrome.tabs.query({});
  let tab = tabs.find((t) => t.url && safeOrigin(t.url) === origin && t.status === 'complete') || tabs.find((t) => t.url && safeOrigin(t.url) === origin);
  let created = false;
  if (!tab) {
    tab = await chrome.tabs.create({ url: origin + '/', active: false });
    created = true;
    await waitForTabComplete(tab.id, 15_000);
  }
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const out = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          out.push({ name: k, value: localStorage.getItem(k) });
        }
        return out;
      },
    });
    return { localStorage: result || [] };
  } catch (e) {
    return { localStorage: [], error: e.message };
  } finally {
    if (created) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

function safeOrigin(url) {
  try { return new URL(url).origin; } catch { return null; }
}

async function collectEnv() {
  let win = null;
  try { win = await chrome.windows.getLastFocused(); } catch { /* ignore */ }
  return {
    userAgent: navigator.userAgent,
    acceptLanguage: (navigator.languages || [navigator.language]).join(','),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    viewport: { w: win?.width || 1280, h: win?.height || 800 },
  };
}

async function exportBundle(origins) {
  const cookies = await collectCookies(origins);
  const origins_storage = [];
  for (const origin of origins) {
    const ls = await readLocalStorage(origin);
    origins_storage.push({ origin, localStorage: ls.localStorage, ...(ls.error ? { error: ls.error } : {}) });
  }
  return {
    version: 1,
    exported_at: Math.floor(Date.now() / 1000),
    origins,
    cookies,
    origins_storage,
    env: await collectEnv(),
  };
}

// ---------------------------------------------------------------- pairing (spec §3.2)

async function pair({ relay, code }) {
  const relay_http = (relay || DEFAULT_RELAY).trim().replace(/\/+$/, '');
  const clean = String(code || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
  if (clean.length !== 8) throw new Error('pairing code must be 8 characters');
  const identity = await getIdentity();
  let res;
  try {
    res = await fetch(`${relay_http}/v1/pairings/${clean}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ext_id: identity.ext_id,
        ext_sign_pk: identity.sign_pk,
        ext_enc_pk: identity.enc_pk,
        display_name: `Chrome (${navigator.platform || 'desktop'})`,
      }),
    });
  } catch (e) {
    throw new Error(`relay unreachable at ${relay_http}: ${e.message}`);
  }
  if (res.status === 404) throw new Error('pairing code not found or expired');
  if (!res.ok) throw new Error(`relay error ${res.status}`);
  const body = await res.json();
  const old = await getPairing();
  if (old && !old.revoked) await revokeAtRelay(old).catch(() => {});
  if (ws) { try { ws.close(1000, 'repaired'); } catch { /* ignore */ } ws = null; }
  const pairing = {
    pairing_id: body.pairing_id,
    relay_http,
    relay_ws: C.wsUrlFor(relay_http),
    token: body.token,
    agent: body.agent,
    agent_fingerprint: C.fingerprint(body.agent.agent_enc_pk),
    proxy: body.proxy || null, // { server, username, password } for tier-2 (spec §4)
    created_at: body.created_at || Math.floor(Date.now() / 1000),
  };
  await store.set({ pairing, requests: {}, seen: [] });
  await updateBadge({});
  await appendLog({ kind: 'paired', text: `Paired with ${body.agent.display_name}` });
  backoffMs = 1000;
  await connect();
  return publicPairing(pairing);
}

async function revokeAtRelay(pairing) {
  await fetch(`${pairing.relay_http}/v1/pairings/${pairing.pairing_id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${pairing.token}` },
  });
}

async function unpair() {
  const pairing = await getPairing();
  if (pairing && !pairing.revoked) await revokeAtRelay(pairing).catch(() => {});
  if (ws) { try { ws.close(1000, 'unpaired'); } catch { /* ignore */ } ws = null; }
  stopPing();
  await clearProxy();
  await chrome.storage.local.remove(['pairing', 'requests', 'seen']);
  await setConn('unpaired');
  await updateBadge({});
  await appendLog({ kind: 'unpaired', text: 'Pairing removed' });
}

function publicPairing(p) {
  if (!p) return null;
  const { token, proxy, ...rest } = p;
  return { ...rest, proxy: proxy ? { server: proxy.server } : null };
}

// ---------------------------------------------------------------- popup API

async function getState() {
  const identity = await getIdentity();
  const [pairing, conn, requests, log] = await Promise.all([
    getPairing(),
    store.get('conn', { state: 'unpaired' }),
    getRequests(),
    store.get('log', []),
  ]);
  return {
    identity: { ext_id: identity.ext_id, fingerprint: C.fingerprint(identity.enc_pk) },
    pairing: publicPairing(pairing),
    conn: pairing ? conn : { state: 'unpaired' },
    requests,
    log,
    default_relay: DEFAULT_RELAY,
    denylist: DENYLIST,
  };
}

async function startRequest(request_id) {
  const requests = await getRequests();
  const r = requests[request_id];
  if (!r) throw new Error('request no longer pending');
  // Tier 2: route this origin's traffic through the relay proxy before the human
  // logs in, so the minted session is bound to the relay's IP (spec §7).
  if (r.tier === 2) {
    await applyProxy(r.origins);
    await appendLog({ kind: 'proxy', request_id, origins: r.origins, text: `Routing ${r.origins.join(', ')} through the relay proxy (tier 2)` });
  }
  const tab = await chrome.tabs.create({ url: r.hint_url, active: true });
  requests[request_id] = { ...r, state: 'started', tab_id: tab.id };
  await setRequests(requests);
}

async function finishRequest(request_id) {
  const requests = await getRequests();
  const r = requests[request_id];
  if (!r) throw new Error('request no longer pending');
  const bundle = await exportBundle(r.origins);
  const proxied = r.tier === 2;
  await sendToAgent('session_bundle', { request_id, bundle, proxied, silent: false });
  if (proxied) await clearProxy(); // login done; stop routing the human's other traffic
  requests[request_id] = { ...r, state: 'sent', sent_at: Date.now(), summary: summarize(bundle), proxied };
  await setRequests(requests);
  await appendLog({ kind: 'sent', request_id, origins: r.origins, text: `Sent ${summarize(bundle)} for ${r.origins.join(', ')}${proxied ? ' (tier 2)' : ''}` });
  return summarize(bundle);
}

function summarize(bundle) {
  const ls = bundle.origins_storage.reduce((n, o) => n + (o.localStorage?.length || 0), 0);
  return `${bundle.cookies.length} cookie(s), ${ls} localStorage item(s)`;
}

async function declineRequest(request_id) {
  const requests = await getRequests();
  const r = requests[request_id];
  if (!r) throw new Error('request no longer pending');
  await sendToAgent('declined', { request_id, reason: 'user' });
  delete requests[request_id];
  await setRequests(requests);
  if (r.tier === 2 && !anyTier2Active(requests)) await clearProxy();
  await appendLog({ kind: 'declined', request_id, origins: r.origins, text: `Declined request for ${r.origins.join(', ')}` });
}

function anyTier2Active(requests) {
  return Object.values(requests).some((r) => r.tier === 2 && (r.state === 'pending' || r.state === 'started'));
}

async function dismissRequest(request_id) {
  const requests = await getRequests();
  delete requests[request_id];
  await setRequests(requests);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handlers = {
    getState: () => getState(),
    pair: () => pair(msg),
    unpair: () => unpair(),
    reconnect: async () => { backoffMs = 1000; await connect(); },
    start: () => startRequest(msg.request_id),
    done: () => finishRequest(msg.request_id),
    decline: () => declineRequest(msg.request_id),
    dismiss: () => dismissRequest(msg.request_id),
  };
  const h = handlers[msg?.type];
  if (!h) return false;
  h().then((result) => sendResponse({ ok: true, result }), (e) => sendResponse({ ok: false, error: e.message || String(e) }));
  return true;
});

// ---------------------------------------------------------------- lifecycle

async function sweepStale() {
  const requests = await getRequests();
  const now = Math.floor(Date.now() / 1000);
  let changed = false;
  for (const [id, r] of Object.entries(requests)) {
    if ((r.state === 'pending' || r.state === 'started') && typeof r.expires_at === 'number' && r.expires_at <= now) {
      delete requests[id];
      changed = true;
      await appendLog({ kind: 'stale', request_id: id, origins: r.origins, text: `Request timed out: ${r.origins.join(', ')}` });
    }
  }
  if (changed) {
    await setRequests(requests);
    if (!anyTier2Active(requests) && (await store.get('activeProxy', null))) await clearProxy();
  }
}

async function boot() {
  try { await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 }); } catch { /* ignore */ }
  await updateBadge();
  await connect();
}

chrome.runtime.onInstalled.addListener(() => boot());
chrome.runtime.onStartup.addListener(() => boot());
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  await sweepStale();
  await connect();
});
boot();
