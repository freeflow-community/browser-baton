// Session Handoff — extension service worker (spec §7, §13).
//
// Holds one pairing, keeps a WebSocket to the relay, turns `needs_session`
// into a badge + notification, and on "Done" exports cookies + localStorage
// for the requested origins and sends an encrypted `session_bundle`.

/* global HandoffCommon */
importScripts('lib/nacl-fast.min.js', 'lib/common.js');
const C = self.HandoffCommon;

const DEFAULT_RELAY = 'https://browser-relay.freeflow.im'; // override via the popup's Relay field
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

// Multi-agent: an extension profile holds many pairings, keyed by pairing_id.
const getPairings = () => store.get('pairings', {});
async function getPairing(id) {
  if (!id) return null;
  const p = await getPairings();
  return p[id] || null;
}
async function putPairing(rec) {
  const p = await getPairings();
  p[rec.pairing_id] = rec;
  await store.set({ pairings: p });
}
async function deletePairingRecord(id) {
  const p = await getPairings();
  delete p[id];
  await store.set({ pairings: p });
}
const agentName = (pairing) => pairing?.label || pairing?.agent?.display_name || pairing?.agent?.agent_id?.slice(0, 8) || 'agent';

const getRequests = () => store.get('requests', {});

async function setRequests(requests) {
  await store.set({ requests });
  await updateBadge(requests);
}

// Per-pairing connection state for the popup.
async function setConn(pairingId, state, extra = {}) {
  const c = await store.get('connState', {});
  c[pairingId] = { state, at: Date.now(), ...extra };
  await store.set({ connState: c });
}
async function clearConn(pairingId) {
  const c = await store.get('connState', {});
  delete c[pairingId];
  await store.set({ connState: c });
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
//
// One WebSocket per pairing (multi-agent, spec §4.2). Each socket authenticates
// its pairing's token and reconnects independently with exponential backoff.

const conns = new Map(); // pairing_id -> { ws, backoffMs, pingTimer, reconnectTimer, connecting }

function connState(id) {
  if (!conns.has(id)) conns.set(id, { ws: null, backoffMs: 1000, pingTimer: null, reconnectTimer: null, connecting: null });
  return conns.get(id);
}

function stopPing(id) {
  const cs = conns.get(id);
  if (cs) { clearInterval(cs.pingTimer); cs.pingTimer = null; }
}

async function connectAll() {
  const pairings = await getPairings();
  const live = new Set(Object.keys(pairings).filter((id) => !pairings[id].revoked));
  for (const id of live) connectPairing(id);
  for (const id of [...conns.keys()]) if (!live.has(id)) disconnectPairing(id, 1000, 'removed');
}

function connectPairing(id) {
  const cs = connState(id);
  if (cs.ws && (cs.ws.readyState === WebSocket.OPEN || cs.ws.readyState === WebSocket.CONNECTING)) return;
  if (cs.connecting) return;
  cs.connecting = doConnectPairing(id).finally(() => { cs.connecting = null; });
}

async function doConnectPairing(id) {
  const pairing = await getPairing(id);
  if (!pairing || pairing.revoked) return;
  const cs = connState(id);
  if (cs.ws && (cs.ws.readyState === WebSocket.OPEN || cs.ws.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(cs.reconnectTimer);
  await setConn(id, 'connecting');
  let sock;
  try {
    sock = new WebSocket(pairing.relay_ws);
  } catch (e) {
    await setConn(id, 'offline', { error: e.message });
    scheduleReconnect(id);
    return;
  }
  cs.ws = sock;
  sock.onopen = () => sock.send(JSON.stringify({ type: 'auth', token: pairing.token }));
  sock.onmessage = (ev) => {
    if (cs.ws !== sock) return; // superseded
    handleWsFrame(id, sock, ev.data).catch((e) => console.error('[handoff] ws frame error', e));
  };
  sock.onerror = () => { /* onclose follows */ };
  sock.onclose = async (ev) => {
    if (cs.ws !== sock) return;
    cs.ws = null;
    stopPing(id);
    if (ev.code === 4001) { await markRevoked(id, ev.reason || 'unpaired'); return; }
    await setConn(id, 'offline', { code: ev.code, reason: ev.reason });
    scheduleReconnect(id);
  };
}

function scheduleReconnect(id) {
  const cs = connState(id);
  clearTimeout(cs.reconnectTimer);
  cs.reconnectTimer = setTimeout(() => connectPairing(id), cs.backoffMs);
  cs.backoffMs = Math.min(cs.backoffMs * 2, 60_000);
}

function disconnectPairing(id, code = 1000, reason = '') {
  const cs = conns.get(id);
  if (!cs) return;
  clearTimeout(cs.reconnectTimer);
  stopPing(id);
  if (cs.ws) { try { cs.ws.close(code, reason); } catch { /* ignore */ } }
  conns.delete(id);
}

async function markRevoked(id, reason) {
  const pairing = await getPairing(id);
  if (pairing) await putPairing({ ...pairing, revoked: true, revoked_at: Date.now() });
  await setConn(id, 'revoked', { reason });
  await appendLog({ kind: 'revoked', text: `Agent ${agentName(pairing)} pairing revoked (${reason})` });
  await dropRequestsForPairing(id);
  disconnectPairing(id, 4001, 'revoked');
}

async function handleWsFrame(id, sock, data) {
  let msg;
  try { msg = JSON.parse(data); } catch { return; }
  const cs = connState(id);
  switch (msg.type) {
    case 'ready':
      cs.backoffMs = 1000;
      await setConn(id, 'online');
      stopPing(id);
      cs.pingTimer = setInterval(() => {
        if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: 'ping' }));
      }, WS_PING_MS);
      break;
    case 'message':
      await handleEnvelope(id, msg.envelope);
      if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: 'ack', msg_id: msg.envelope.msg_id }));
      break;
    case 'revoked':
      await markRevoked(id, 'revoked');
      break;
    case 'pong':
    case 'sent':
      break;
    case 'error':
      console.warn('[handoff] relay error', msg);
      if (msg.error === 'unpaired') await markRevoked(id, 'unpaired');
      break;
    default:
      break;
  }
}

async function sendToAgent(pairingId, type, payload) {
  const pairing = await getPairing(pairingId);
  if (!pairing || pairing.revoked) throw new Error('not paired');
  const identity = await getIdentity();
  const envelope = C.makeEnvelope({ pairing_id: pairing.pairing_id, type, payload, recipientPkB64: pairing.agent.agent_enc_pk, signSkB64: identity.sign_sk });
  const res = await fetch(`${pairing.relay_http}/v1/pairings/${pairing.pairing_id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${pairing.token}` },
    body: JSON.stringify(envelope),
  });
  if (res.status === 401 || res.status === 404 || res.status === 410) {
    await markRevoked(pairingId, 'unpaired');
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

async function handleEnvelope(pairingId, env) {
  if (!env || env.from !== 'agent') return;
  if (await alreadySeen(env.msg_id)) return;
  const pairing = await getPairing(pairingId);
  if (!pairing || pairing.revoked) return;
  if (!C.verifyEnvelope(env, pairing.agent.agent_sign_pk)) {
    await appendLog({ kind: 'error', text: `Dropped ${env.type} from ${agentName(pairing)}: bad signature` });
    return;
  }
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
      return onNeedsSession(pairingId, payload);
    case 'report':
      return onReport(pairingId, payload);
    case 'revoke_session':
      await appendLog({ kind: 'revoke_session', text: `${agentName(pairing)} asks you to log out of ${(payload.origins || []).join(', ')}` });
      return;
    default:
      await appendLog({ kind: 'error', text: `Unknown message type ${env.type}` });
  }
}

async function onNeedsSession(pairingId, p) {
  if (!p || typeof p.request_id !== 'string' || !Array.isArray(p.origins) || !p.origins.length) return;
  const pairing = await getPairing(pairingId);
  if (!pairing) return;
  const now = Math.floor(Date.now() / 1000);
  if (typeof p.expires_at === 'number' && p.expires_at <= now) {
    await appendLog({ kind: 'stale', request_id: p.request_id, text: `Ignored expired request for ${p.origins.join(', ')}` });
    return;
  }
  const blocked = denylisted(p.origins);
  if (blocked.length) {
    await sendToAgent(pairingId, 'declined', { request_id: p.request_id, reason: 'denylist' });
    await appendLog({ kind: 'denylist', request_id: p.request_id, origins: p.origins, text: `Declined ${agentName(pairing)} (denylist): ${blocked.join(', ')}` });
    return;
  }
  const requests = await getRequests();
  const key = originsKey(p.origins);
  // Idempotency (spec §5.2), scoped per agent: replace an identical unanswered
  // request from the SAME pairing; the same origins from another agent is distinct.
  for (const [id, r] of Object.entries(requests)) {
    if ((r.state === 'pending' || r.state === 'started') && r.pairing_id === pairingId && (id === p.request_id || originsKey(r.origins) === key)) {
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
    pairing_id: pairingId,
    agent_name: agentName(pairing),
    agent_fingerprint: pairing.agent_fingerprint,
    origins: p.origins,
    tier: p.tier || 1,
    hint_url: p.hint_url || p.origins[0] + '/',
    task_label: p.task_label || 'Agent needs a session',
    agent_context: typeof p.agent_context === 'string' ? p.agent_context.slice(0, 200) : null,
    expires_at: p.expires_at,
    allow_silent: Boolean(p.allow_silent),
    state: 'pending',
    received_at: Date.now(),
  };
  await setRequests(requests);
  await appendLog({ kind: 'request', request_id: p.request_id, origins: p.origins, text: `${agentName(pairing)} requested a session: ${p.task_label || ''} (${p.origins.join(', ')})` });
  notify(p.request_id, `${agentName(pairing)} needs a session`, `${p.task_label || ''}\n${p.origins.join(', ')}`);
  // Pop a compact window so the human sees Start / Done / Decline without hunting
  // for the toolbar icon. Chrome can't reliably open the action popup on a
  // background event, but it can open a window (spec §7 interactive path).
  await openRequestWindow();
}

async function onReport(pairingId, p) {
  if (!p || typeof p.request_id !== 'string') return;
  const requests = await getRequests();
  const r = requests[p.request_id];
  if (r && r.pairing_id !== pairingId) return; // a report may only touch its own agent's request
  if (r) {
    requests[p.request_id] = { ...r, state: 'reported', result: { ok: Boolean(p.ok), reason: p.reason || null, at: Date.now() } };
    await setRequests(requests);
  }
  const who = r ? r.agent_name : 'Agent';
  const text = p.ok ? `${who} reports the session worked` : `${who} reports failure: ${p.reason || 'unspecified'}`;
  await appendLog({ kind: 'report', request_id: p.request_id, origins: r?.origins, ok: Boolean(p.ok), text });
  notify(`report-${p.request_id}`, p.ok ? '✓︎ Session handoff worked' : '✗︎ Session handoff failed', p.ok ? (r?.origins || []).join(', ') : p.reason || 'unspecified');
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

async function applyProxy(pairingId, requestId, origins) {
  const pairing = await getPairing(pairingId);
  if (!pairing?.proxy) throw new Error('no proxy credentials for this pairing');
  // Spec §10: one tier-2 login at a time — the browser's proxy auth can't tell
  // which agent a proxied connection belongs to.
  const active = await store.get('activeProxy', null);
  if (active && active.request_id !== requestId) throw new Error('another tier-2 login is in progress; finish or decline it first');
  const hosts = [...new Set(origins.map((o) => { try { return new URL(o).hostname; } catch { return null; } }).filter(Boolean))];
  const config = { mode: 'pac_script', pacScript: { data: pacScript(hosts, pairing.proxy.server) } };
  await chrome.proxy.settings.set({ value: config, scope: 'regular' });
  proxyAuthActive = { ...pairing.proxy };
  await store.set({ activeProxy: { pairing_id: pairingId, request_id: requestId, hosts, server: pairing.proxy.server, at: Date.now() } });
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
  const pairing = await getPairing(ap.pairing_id);
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

async function pair({ relay, code, label }) {
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
  // Re-pairing the same agent replaces its registration (re-key) rather than duplicating.
  const pairings = await getPairings();
  const existing = Object.values(pairings).find((p) => p.agent?.agent_id === body.agent.agent_id && !p.revoked && p.pairing_id !== body.pairing_id);
  let carriedLabel = null;
  if (existing) {
    carriedLabel = existing.label;
    await revokeAtRelay(existing).catch(() => {});
    disconnectPairing(existing.pairing_id, 1000, 'repaired');
    await deletePairingRecord(existing.pairing_id);
    await clearConn(existing.pairing_id);
  }
  const rec = {
    pairing_id: body.pairing_id,
    relay_http,
    relay_ws: C.wsUrlFor(relay_http),
    token: body.token,
    agent: body.agent,
    agent_fingerprint: C.fingerprint(body.agent.agent_enc_pk),
    label: (label && label.trim()) || carriedLabel || body.agent.display_name || body.agent.agent_id.slice(0, 8),
    proxy: body.proxy || null, // { server, username, password } for tier-2 (spec §4)
    created_at: body.created_at || Math.floor(Date.now() / 1000),
  };
  await putPairing(rec);
  await updateBadge();
  await appendLog({ kind: 'paired', text: `Registered agent ${rec.label}` });
  connectPairing(rec.pairing_id);
  return publicPairing(rec);
}

async function revokeAtRelay(pairing) {
  await fetch(`${pairing.relay_http}/v1/pairings/${pairing.pairing_id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${pairing.token}` },
  });
}

// Remove one agent's pending requests (and any proxy it owns) — used on revoke.
async function dropRequestsForPairing(pairingId) {
  const requests = await getRequests();
  let changed = false;
  for (const [rid, r] of Object.entries(requests)) {
    if (r.pairing_id === pairingId) {
      delete requests[rid];
      changed = true;
      if (r.tab_id != null) await removePanel(r.tab_id);
    }
  }
  if (changed) await setRequests(requests);
  const ap = await store.get('activeProxy', null);
  if (ap && ap.pairing_id === pairingId) await clearProxy();
}

async function revokePairing(pairingId) {
  const pairing = await getPairing(pairingId);
  if (pairing && !pairing.revoked) await revokeAtRelay(pairing).catch(() => {});
  disconnectPairing(pairingId, 1000, 'unpaired');
  await dropRequestsForPairing(pairingId);
  await deletePairingRecord(pairingId);
  await clearConn(pairingId);
  await updateBadge();
  await appendLog({ kind: 'unpaired', text: `Removed agent ${agentName(pairing)}` });
}

async function renamePairing(pairingId, label) {
  const pairing = await getPairing(pairingId);
  if (!pairing) throw new Error('unknown agent');
  const clean = String(label || '').trim().slice(0, 60) || pairing.agent.display_name;
  await putPairing({ ...pairing, label: clean });
  return clean;
}

function publicPairing(p) {
  if (!p) return null;
  const { token, proxy, ...rest } = p;
  return { ...rest, proxy: proxy ? { server: proxy.server } : null };
}

// ---------------------------------------------------------------- popup API

async function getState() {
  const identity = await getIdentity();
  const [pairings, connMap, requests, log] = await Promise.all([
    getPairings(),
    store.get('connState', {}),
    getRequests(),
    store.get('log', []),
  ]);
  const agents = Object.values(pairings)
    .filter((p) => !p.revoked)
    .sort((a, b) => (a.created_at || 0) - (b.created_at || 0))
    .map((p) => ({ ...publicPairing(p), conn: connMap[p.pairing_id] || { state: 'connecting' } }));
  return {
    identity: { ext_id: identity.ext_id, fingerprint: C.fingerprint(identity.enc_pk) },
    agents,
    requests,
    log,
    default_relay: DEFAULT_RELAY,
    denylist: DENYLIST,
  };
}

// ---------------------------------------------------------------- in-page panel
//
// After Start opens the login tab, inject a small floating panel there with Done
// and Decline, so the human never has to hunt for the popup window. It is
// re-injected on every load of that tab so it survives the login redirects.

// Runs in the page (isolated content-script world). Self-contained — no closures.
function renderHandoffPanel(data) {
  const ID = 'handoff-panel-host-v1';
  if (document.getElementById(ID)) return; // already present on this document
  const host = document.createElement('div');
  host.id = ID;
  // Bottom-right, clear of the top nav / cookie banners most sites pin up top.
  host.style.cssText = 'all:initial;position:fixed;bottom:18px;right:18px;z-index:2147483647;display:block;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      /* force text (not colour-emoji) presentation so glyphs like ✕/✓ stay small and uniform */
      *{box-sizing:border-box;font-variant-emoji:text}
      .card{font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;width:300px;
        background:#111418;color:#e6e8eb;border:1px solid #2a3038;border-top:3px solid #2563eb;border-radius:12px;
        box-shadow:0 12px 40px rgba(0,0,0,.45);overflow:hidden}
      .hd{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#181c22;border-bottom:1px solid #2a3038}
      .dot{width:9px;height:9px;border-radius:50%;background:#d97706;flex:none}
      .hd b{font-size:12px;font-weight:600}
      .hd .agent{margin-left:auto;font-size:11px;color:#9aa3ad;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .bd{padding:10px 12px}
      .lbl{font-weight:600;margin-bottom:4px}
      .org{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#9aa3ad;word-break:break-all;margin-bottom:2px}
      .tip{color:#9aa3ad;font-size:11px;margin:8px 0 10px}
      .row{display:flex;gap:8px}
      button{font:inherit;flex:1;padding:8px 10px;border-radius:8px;border:1px solid #2a3038;
        background:#20262e;color:#e6e8eb;cursor:pointer}
      button.p{background:#2563eb;border-color:#2563eb;color:#fff;font-weight:600}
      button:disabled{opacity:.55;cursor:default}
      .st{margin-top:8px;font-size:11px;color:#9aa3ad;min-height:14px}
      .ok{color:#34d399}.bad{color:#f87171}
      .x{margin-left:auto;background:none;border:none;color:#9aa3ad;cursor:pointer;font-size:18px;line-height:1;flex:none;width:auto;padding:0 2px}
    </style>
    <div class="card">
      <div class="hd"><span class="dot"></span><b>Session Handoff</b><span class="agent"></span>
        <button class="x" title="Hide" aria-label="Hide">×</button></div>
      <div class="bd">
        <div class="lbl"></div>
        <div class="orgs"></div>
        <div class="tip">Log in on this page, then click Done to send the session to the agent.</div>
        <div class="row">
          <button class="done p">Done — send session</button>
          <button class="decline">Decline</button>
        </div>
        <div class="st"></div>
      </div>
    </div>`;
  root.querySelector('.lbl').textContent = data.label || 'Agent needs a session';
  if (data.agent) root.querySelector('.agent').textContent = data.agent;
  const orgs = root.querySelector('.orgs');
  for (const o of data.origins || []) {
    const d = document.createElement('div');
    d.className = 'org';
    d.textContent = o + (data.tier === 2 ? '  · via relay proxy' : '');
    orgs.appendChild(d);
  }
  const st = root.querySelector('.st');
  const done = root.querySelector('.done');
  const decline = root.querySelector('.decline');
  const send = (type) => {
    if (!chrome.runtime?.id) { st.textContent = 'Extension unavailable; use the popup.'; st.className = 'st bad'; return; }
    done.disabled = decline.disabled = true;
    st.className = 'st';
    st.textContent = type === 'done' ? 'Exporting cookies and localStorage…' : 'Declining…';
    chrome.runtime.sendMessage({ type, request_id: data.request_id }, (res) => {
      if (chrome.runtime.lastError) { st.className = 'st bad'; st.textContent = chrome.runtime.lastError.message; done.disabled = decline.disabled = false; return; }
      if (!res || !res.ok) { st.className = 'st bad'; st.textContent = (res && res.error) || 'failed'; done.disabled = decline.disabled = false; return; }
      st.className = 'st ok';
      st.textContent = type === 'done' ? '\u2713\uFE0E Session sent. You can close this tab.' : 'Declined.';
      setTimeout(() => host.remove(), type === 'done' ? 4000 : 1200);
    });
  };
  done.onclick = () => send('done');
  decline.onclick = () => send('decline');
  root.querySelector('.x').onclick = () => host.remove();
  (document.body || document.documentElement).appendChild(host);
}

function removeHandoffPanel() {
  const el = document.getElementById('handoff-panel-host-v1');
  if (el) el.remove();
}

// Reflect a completion into the panel (when Done/Decline came from the popup
// window rather than the panel itself), then let it fade out.
function setHandoffPanelStatus(kind) {
  const host = document.getElementById('handoff-panel-host-v1');
  if (!host || !host.shadowRoot) return;
  host.shadowRoot.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  const st = host.shadowRoot.querySelector('.st');
  if (st) {
    st.className = 'st ' + (kind === 'sent' ? 'ok' : '');
    st.textContent = kind === 'sent' ? '\u2713\uFE0E Session sent. You can close this tab.' : 'Declined.';
  }
  setTimeout(() => host.remove(), kind === 'sent' ? 4000 : 1200);
}

async function injectPanel(tabId, r) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: renderHandoffPanel,
      args: [{ request_id: r.request_id, label: r.task_label, agent: r.agent_name, origins: r.origins, tier: r.tier || 1 }],
    });
  } catch (e) {
    // Some pages (chrome://, the Web Store) refuse injection; the popup window still works.
    console.debug('[handoff] panel injection skipped', e?.message);
  }
}

async function removePanel(tabId) {
  if (tabId == null) return;
  try { await chrome.scripting.executeScript({ target: { tabId }, func: removeHandoffPanel }); } catch { /* tab gone */ }
}

// Soft-update the panel to a terminal state (leaves the success message visible).
async function markPanel(tabId, kind) {
  if (tabId == null) return;
  try { await chrome.scripting.executeScript({ target: { tabId }, func: setHandoffPanelStatus, args: [kind] }); } catch { /* tab gone */ }
}

// Re-inject the panel whenever the login tab finishes loading (survives redirects).
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  const requests = await getRequests();
  const r = Object.values(requests).find((x) => x.tab_id === tabId && x.state === 'started');
  if (r) await injectPanel(tabId, r);
});

async function startRequest(request_id) {
  const requests = await getRequests();
  const r = requests[request_id];
  if (!r) throw new Error('request no longer pending');
  // Tier 2: route this origin's traffic through the relay proxy before the human
  // logs in, so the minted session is bound to the relay's IP (spec §7).
  if (r.tier === 2) {
    await applyProxy(r.pairing_id, request_id, r.origins);
    await appendLog({ kind: 'proxy', request_id, origins: r.origins, text: `Routing ${r.origins.join(', ')} through the relay proxy (tier 2)` });
  }
  const tab = await chrome.tabs.create({ url: r.hint_url, active: true });
  requests[request_id] = { ...r, state: 'started', tab_id: tab.id };
  await setRequests(requests);
  await injectPanel(tab.id, requests[request_id]); // onUpdated will re-inject on load too
}

async function finishRequest(request_id) {
  const requests = await getRequests();
  const r = requests[request_id];
  if (!r) throw new Error('request no longer pending');
  const bundle = await exportBundle(r.origins);
  const proxied = r.tier === 2;
  await sendToAgent(r.pairing_id, 'session_bundle', { request_id, bundle, proxied, silent: false });
  if (proxied) await clearProxy(); // login done; stop routing the human's other traffic
  requests[request_id] = { ...r, state: 'sent', sent_at: Date.now(), summary: summarize(bundle), proxied };
  await setRequests(requests);
  if (r.tab_id != null) await markPanel(r.tab_id, 'sent'); // reflect if Done came from the popup window
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
  await sendToAgent(r.pairing_id, 'declined', { request_id, reason: 'user' });
  delete requests[request_id];
  await setRequests(requests);
  if (r.tier === 2 && !anyTier2Active(requests)) await clearProxy();
  if (r.tab_id != null) await markPanel(r.tab_id, 'declined');
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
    pair: () => pair(msg),                          // register another agent
    rename: () => renamePairing(msg.pairing_id, msg.label),
    revoke: () => revokePairing(msg.pairing_id),    // remove one agent
    reconnect: async () => { for (const cs of conns.values()) cs.backoffMs = 1000; await connectAll(); },
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
      if (r.tab_id != null) await removePanel(r.tab_id);
      await appendLog({ kind: 'stale', request_id: id, origins: r.origins, text: `Request timed out: ${r.origins.join(', ')}` });
    }
  }
  if (changed) {
    await setRequests(requests);
    if (!anyTier2Active(requests) && (await store.get('activeProxy', null))) await clearProxy();
  }
}

// Migrate a pre-multi-agent single `pairing` into the `pairings` map.
async function migrate() {
  const old = await store.get('pairing', null);
  if (!old) return;
  const pairings = await getPairings();
  if (!pairings[old.pairing_id]) {
    pairings[old.pairing_id] = { ...old, label: old.label || old.agent?.display_name || 'agent' };
    await store.set({ pairings });
  }
  await chrome.storage.local.remove(['pairing', 'conn']);
  await appendLog({ kind: 'paired', text: 'Migrated existing pairing to the multi-agent store' });
}

async function boot() {
  try { await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 }); } catch { /* ignore */ }
  await migrate();
  await updateBadge();
  await connectAll();
}

chrome.runtime.onInstalled.addListener(() => boot());
chrome.runtime.onStartup.addListener(() => boot());
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  await sweepStale();
  await connectAll();
});
boot();
