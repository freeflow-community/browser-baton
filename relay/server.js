// Browser Session Share relay — MVP (spec §10, §13).
//
// Single process. In-memory pairing table and per-pairing message queues,
// optionally snapshotted to a JSON file so a relay restart does not force
// everyone to re-pair. Envelopes are stored opaquely: the relay never sees
// plaintext bundles.
//
// HTTP (CLI):
//   POST   /v1/pairings/begin                 -> { pairing_code, expires_at }
//   GET    /v1/pairings/:code/wait?wait=30    -> pairing record once accepted (204 while waiting, 410 expired)
//   POST   /v1/pairings/:code/accept          -> pairing record for the extension
//   POST   /v1/pairings/:id/messages          -> enqueue envelope for the other side
//   GET    /v1/pairings/:id/messages?wait=30  -> undelivered envelopes for the caller's side
//   POST   /v1/pairings/:id/messages/ack      -> { msg_ids } remove delivered envelopes
//   GET    /v1/pairings/:id                   -> status
//   DELETE /v1/pairings/:id                   -> revoke
// WebSocket (extension):
//   /v1/ext  first frame {type:"auth", token}; then {type:"message", envelope} pushes,
//            {type:"ack", msg_id} from the extension, {type:"ping"}/{type:"pong"}.
// Proxy (tier 2, separate port): HTTP CONNECT + forward proxy with per-pairing
//   Basic auth; both the human's login and the agent's traffic egress from here.

import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
// Tier-2 CONNECT/forward proxy (spec §4, §10). Egress is this process's IP, so a
// session minted through it is bound to the relay's address, not the human's.
const PROXY_PORT = Number(process.env.PROXY_PORT || 8788);
const PROXY_ADDR = process.env.RELAY_PROXY_ADDR || `${HOST}:${PROXY_PORT}`;
const MAX_PROXY_LOG = 20;
// Optional split-horizon resolve override for the proxy's upstream connects,
// e.g. RELAY_PROXY_RESOLVE="site.test=127.0.0.1,idp.test=127.0.0.1". Lets a test
// (or a private deployment) point specific hostnames at fixed addresses.
const PROXY_RESOLVE = new Map(
  (process.env.RELAY_PROXY_RESOLVE || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => { const i = p.indexOf('='); return [p.slice(0, i).toLowerCase(), p.slice(i + 1)]; }),
);
const resolveHost = (h) => PROXY_RESOLVE.get(String(h).toLowerCase()) || h;
const MSG_TTL_MS = Number(process.env.RELAY_MSG_TTL_MS || 24 * 60 * 60 * 1000);
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_WAIT_S = 60;
const MAX_QUEUE = 200;
const MAX_BODY = 8 * 1024 * 1024; // bundles with localStorage can be large
const MAX_CODE_ATTEMPTS = 5;
const STATE_FILE = process.env.RELAY_STATE_FILE === ''
  ? null
  : (process.env.RELAY_STATE_FILE || path.join(__dirname, 'data', 'state.json'));
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// ---------------------------------------------------------------- state

/** @type {Map<string, {code:string, agent:object, expires_at:number, pairing_id:string|null, attempts:number, waiters:Set<Function>}>} */
const pendingPairings = new Map();
/** @type {Map<string, {pairing_id:string, agent:object, ext:object, tokens:{agent:string, ext:string}, created_at:number, queues:{agent:object[], ext:object[]}}>} */
const pairings = new Map();
/** @type {Map<string, {pairing_id:string, side:'agent'|'ext'}>} */
const tokens = new Map();
/** @type {Map<string, {pairing_id:string, password:string}>} proxy username -> creds */
const proxyCreds = new Map();
/** @type {Map<string, {method:string, host:string, at:number}[]>} pairing_id -> recent proxy events */
const proxyLog = new Map();
// Runtime-only (not persisted)
const agentWaiters = new Map(); // pairing_id -> Set<Function>
const extSockets = new Map(); // pairing_id -> ws

function loadState() {
  if (!STATE_FILE || !fs.existsSync(STATE_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const p of raw.pairings || []) {
      pairings.set(p.pairing_id, p);
      tokens.set(p.tokens.agent, { pairing_id: p.pairing_id, side: 'agent' });
      tokens.set(p.tokens.ext, { pairing_id: p.pairing_id, side: 'ext' });
      if (p.proxy) proxyCreds.set(p.proxy.username, { pairing_id: p.pairing_id, password: p.proxy.password });
    }
    log(`loaded ${pairings.size} pairing(s) from ${STATE_FILE}`);
  } catch (e) {
    log(`could not load state file: ${e.message}`);
  }
}

let saveTimer = null;
function saveState() {
  if (!STATE_FILE) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      const tmp = STATE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ pairings: [...pairings.values()] }));
      fs.renameSync(tmp, STATE_FILE);
    } catch (e) {
      log(`could not save state: ${e.message}`);
    }
  }, 200);
}

function log(...args) {
  console.error(new Date().toISOString(), '[relay]', ...args);
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function newProxyCreds(pairingId) {
  return {
    username: `p_${pairingId.slice(0, 8)}_${crypto.randomBytes(3).toString('hex')}`,
    password: crypto.randomBytes(24).toString('base64url'),
  };
}

function newCode() {
  let code = '';
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return pendingPairings.has(code) ? newCode() : code;
}

function sweep() {
  const now = Date.now();
  for (const [code, p] of pendingPairings) {
    if (p.expires_at < now) {
      for (const w of p.waiters) w({ status: 410 });
      pendingPairings.delete(code);
    }
  }
  let dirty = false;
  for (const p of pairings.values()) {
    for (const side of ['agent', 'ext']) {
      const before = p.queues[side].length;
      p.queues[side] = p.queues[side].filter((m) => m.received_at + MSG_TTL_MS > now);
      if (p.queues[side].length !== before) dirty = true;
    }
  }
  if (dirty) saveState();
}
setInterval(sweep, 60 * 1000).unref();

// ---------------------------------------------------------------- http helpers

class HttpError extends Error {
  constructor(status, error, extra) {
    super(error);
    this.status = status;
    this.body = { error, ...extra };
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
  });
  res.end(data);
}

function authenticate(req, pairingId) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) throw new HttpError(401, 'unauthorized');
  const t = tokens.get(m[1].trim());
  if (!t || t.pairing_id !== pairingId) throw new HttpError(401, 'unpaired');
  const pairing = pairings.get(pairingId);
  if (!pairing) throw new HttpError(404, 'unpaired');
  return { pairing, side: t.side };
}

function waitSeconds(url) {
  const w = Number(url.searchParams.get('wait') || 0);
  return Math.max(0, Math.min(MAX_WAIT_S, Number.isFinite(w) ? w : 0));
}

function requireString(obj, key, max = 4096) {
  const v = obj[key];
  if (typeof v !== 'string' || !v.length || v.length > max) throw new HttpError(400, 'bad_request', { field: key });
  return v;
}

// ---------------------------------------------------------------- pairing

function beginPairing(body) {
  const agent = {
    agent_id: requireString(body, 'agent_id', 128),
    agent_sign_pk: requireString(body, 'agent_sign_pk', 128),
    agent_enc_pk: requireString(body, 'agent_enc_pk', 128),
    display_name: typeof body.display_name === 'string' ? body.display_name.slice(0, 64) : 'agent',
  };
  const code = newCode();
  const expires_at = Date.now() + CODE_TTL_MS;
  pendingPairings.set(code, { code, agent, expires_at, pairing_id: null, attempts: 0, waiters: new Set() });
  log(`pairing code issued for ${agent.display_name} (${agent.agent_id.slice(0, 8)}…)`);
  return { pairing_code: code, expires_at: Math.floor(expires_at / 1000) };
}

function agentPairingView(p) {
  return {
    pairing_id: p.pairing_id,
    token: p.tokens.agent,
    ext: { ext_id: p.ext.ext_id, ext_enc_pk: p.ext.ext_enc_pk, ext_sign_pk: p.ext.ext_sign_pk, display_name: p.ext.display_name },
    proxy: { server: PROXY_ADDR, username: p.proxy.username, password: p.proxy.password },
    created_at: p.created_at,
  };
}

async function waitPairing(code, wait) {
  const pending = pendingPairings.get(code);
  if (!pending) throw new HttpError(410, 'code_expired');
  if (pending.pairing_id) {
    pendingPairings.delete(code);
    return { status: 200, body: agentPairingView(pairings.get(pending.pairing_id)) };
  }
  if (wait === 0) return { status: 204 };
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.waiters.delete(done);
      resolve({ status: 204 });
    }, wait * 1000);
    const done = (r) => {
      clearTimeout(timer);
      pending.waiters.delete(done);
      if (r.status === 200) {
        pendingPairings.delete(code);
        resolve({ status: 200, body: agentPairingView(pairings.get(pending.pairing_id)) });
      } else resolve(r);
    };
    pending.waiters.add(done);
  });
}

function acceptPairing(code, body) {
  const pending = pendingPairings.get(code.toUpperCase());
  if (!pending || pending.expires_at < Date.now()) throw new HttpError(404, 'code_not_found');
  if (pending.pairing_id) throw new HttpError(409, 'already_accepted');
  const ext = {
    ext_id: requireString(body, 'ext_id', 128),
    ext_sign_pk: requireString(body, 'ext_sign_pk', 128),
    ext_enc_pk: requireString(body, 'ext_enc_pk', 128),
    display_name: typeof body.display_name === 'string' ? body.display_name.slice(0, 64) : 'extension',
  };
  const pairing_id = crypto.randomUUID();
  const record = {
    pairing_id,
    agent: pending.agent,
    ext,
    tokens: { agent: newToken(), ext: newToken() },
    proxy: newProxyCreds(pairing_id),
    created_at: Math.floor(Date.now() / 1000),
    queues: { agent: [], ext: [] },
  };
  pairings.set(pairing_id, record);
  tokens.set(record.tokens.agent, { pairing_id, side: 'agent' });
  tokens.set(record.tokens.ext, { pairing_id, side: 'ext' });
  proxyCreds.set(record.proxy.username, { pairing_id, password: record.proxy.password });
  pending.pairing_id = pairing_id;
  for (const w of [...pending.waiters]) w({ status: 200 });
  saveState();
  log(`pairing ${pairing_id.slice(0, 8)} accepted: ${pending.agent.display_name} <-> ${ext.display_name}`);
  return {
    pairing_id,
    token: record.tokens.ext,
    agent: { ...pending.agent },
    proxy: { server: PROXY_ADDR, username: record.proxy.username, password: record.proxy.password },
    created_at: record.created_at,
  };
}

function revokePairing(pairingId) {
  const p = pairings.get(pairingId);
  if (!p) return;
  pairings.delete(pairingId);
  tokens.delete(p.tokens.agent);
  tokens.delete(p.tokens.ext);
  if (p.proxy) proxyCreds.delete(p.proxy.username); // rotate proxy creds on revoke (spec §3.3, §11)
  proxyLog.delete(pairingId);
  for (const w of agentWaiters.get(pairingId) || []) w({ status: 410 });
  agentWaiters.delete(pairingId);
  const ws = extSockets.get(pairingId);
  if (ws) {
    try { ws.send(JSON.stringify({ type: 'revoked' })); ws.close(4001, 'revoked'); } catch { /* ignore */ }
    extSockets.delete(pairingId);
  }
  saveState();
  log(`pairing ${pairingId.slice(0, 8)} revoked`);
}

// ---------------------------------------------------------------- messages

function validateEnvelope(env, pairing, side) {
  if (!env || typeof env !== 'object') throw new HttpError(400, 'bad_envelope');
  if (env.v !== 1) throw new HttpError(400, 'bad_envelope', { field: 'v' });
  if (env.pairing_id !== pairing.pairing_id) throw new HttpError(400, 'bad_envelope', { field: 'pairing_id' });
  if (env.from !== side) throw new HttpError(403, 'bad_envelope', { field: 'from' });
  requireString(env, 'msg_id', 128);
  requireString(env, 'type', 64);
  requireString(env, 'payload', MAX_BODY);
  if (typeof env.ts !== 'number') throw new HttpError(400, 'bad_envelope', { field: 'ts' });
  if (typeof env.sig !== 'string') throw new HttpError(400, 'bad_envelope', { field: 'sig' });
  return {
    v: 1,
    pairing_id: env.pairing_id,
    msg_id: env.msg_id,
    type: env.type,
    ts: env.ts,
    from: env.from,
    payload: env.payload,
    sig: env.sig,
  };
}

function enqueue(pairing, fromSide, envelope) {
  const toSide = fromSide === 'agent' ? 'ext' : 'agent';
  const queue = pairing.queues[toSide];
  const existing = queue.find((m) => m.envelope.msg_id === envelope.msg_id);
  if (existing) return { duplicate: true, msg_id: envelope.msg_id };
  if (queue.length >= MAX_QUEUE) throw new HttpError(429, 'queue_full');
  queue.push({ envelope, received_at: Date.now(), delivered: false });
  saveState();
  if (toSide === 'agent') {
    for (const w of [...(agentWaiters.get(pairing.pairing_id) || [])]) w({ status: 200 });
  } else {
    pushToExtension(pairing);
  }
  return { duplicate: false, msg_id: envelope.msg_id };
}

function pushToExtension(pairing) {
  const ws = extSockets.get(pairing.pairing_id);
  if (!ws || ws.readyState !== ws.OPEN) return;
  for (const m of pairing.queues.ext) {
    // Re-send everything undelivered; extension dedupes by msg_id (at-least-once).
    try {
      ws.send(JSON.stringify({ type: 'message', envelope: m.envelope }));
      m.delivered = true;
    } catch (e) {
      log(`ws send failed: ${e.message}`);
    }
  }
}

async function pollMessages(pairing, side, wait) {
  const pending = () => pairing.queues[side].map((m) => m.envelope);
  let msgs = pending();
  if (msgs.length || wait === 0) return { status: 200, body: { messages: msgs } };
  const id = pairing.pairing_id;
  if (!agentWaiters.has(id)) agentWaiters.set(id, new Set());
  const waiters = agentWaiters.get(id);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(done);
      resolve({ status: 200, body: { messages: pending() } });
    }, wait * 1000);
    const done = (r) => {
      clearTimeout(timer);
      waiters.delete(done);
      if (r.status === 410) resolve({ status: 410, body: { error: 'unpaired' } });
      else resolve({ status: 200, body: { messages: pending() } });
    };
    waiters.add(done);
  });
}

function ackMessages(pairing, side, msgIds) {
  if (!Array.isArray(msgIds)) throw new HttpError(400, 'bad_request', { field: 'msg_ids' });
  const set = new Set(msgIds);
  const before = pairing.queues[side].length;
  pairing.queues[side] = pairing.queues[side].filter((m) => !set.has(m.envelope.msg_id));
  const removed = before - pairing.queues[side].length;
  if (removed) saveState();
  return { acked: removed };
}

function statusView(pairing) {
  return {
    pairing_id: pairing.pairing_id,
    created_at: pairing.created_at,
    agent: { agent_id: pairing.agent.agent_id, display_name: pairing.agent.display_name },
    ext: { ext_id: pairing.ext.ext_id, display_name: pairing.ext.display_name },
    ext_connected: extSockets.has(pairing.pairing_id),
    queued: { to_agent: pairing.queues.agent.length, to_ext: pairing.queues.ext.length },
    proxy: { server: PROXY_ADDR, recent: (proxyLog.get(pairing.pairing_id) || []).slice(-MAX_PROXY_LOG) },
  };
}

// ---------------------------------------------------------------- router

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'relay'}`);
  const parts = url.pathname.split('/').filter(Boolean);
  const method = req.method;

  if (method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true, pairings: pairings.size });

  if (parts[0] !== 'v1' || parts[1] !== 'pairings') throw new HttpError(404, 'not_found');

  // POST /v1/pairings/begin
  if (method === 'POST' && parts[2] === 'begin' && parts.length === 3) {
    return send(res, 200, beginPairing(await readJson(req)));
  }
  // GET /v1/pairings/:code/wait
  if (method === 'GET' && parts[3] === 'wait' && parts.length === 4) {
    const r = await waitPairing(parts[2].toUpperCase(), waitSeconds(url));
    return send(res, r.status, r.body);
  }
  // POST /v1/pairings/:code/accept
  if (method === 'POST' && parts[3] === 'accept' && parts.length === 4) {
    const code = parts[2].toUpperCase();
    const body = await readJson(req);
    try {
      return send(res, 200, acceptPairing(code, body));
    } catch (e) {
      // brute-force guard: count misses against any live code prefix-less; cheap MVP approach
      if (e.status === 404) {
        for (const p of pendingPairings.values()) {
          if (++p.attempts > MAX_CODE_ATTEMPTS * 20) pendingPairings.delete(p.code);
        }
      }
      throw e;
    }
  }

  const pairingId = parts[2];
  if (!pairingId) throw new HttpError(404, 'not_found');

  // GET/DELETE /v1/pairings/:id
  if (parts.length === 3) {
    const { pairing } = authenticate(req, pairingId);
    if (method === 'GET') return send(res, 200, statusView(pairing));
    if (method === 'DELETE') { revokePairing(pairingId); return send(res, 200, { ok: true }); }
    throw new HttpError(405, 'method_not_allowed');
  }
  // /v1/pairings/:id/messages
  if (parts[3] === 'messages' && parts.length === 4) {
    const { pairing, side } = authenticate(req, pairingId);
    if (method === 'POST') {
      const env = validateEnvelope(await readJson(req), pairing, side);
      const r = enqueue(pairing, side, env);
      return send(res, r.duplicate ? 200 : 202, r);
    }
    if (method === 'GET') {
      const r = await pollMessages(pairing, side, waitSeconds(url));
      return send(res, r.status, r.body);
    }
    throw new HttpError(405, 'method_not_allowed');
  }
  // POST /v1/pairings/:id/messages/ack
  if (method === 'POST' && parts[3] === 'messages' && parts[4] === 'ack' && parts.length === 5) {
    const { pairing, side } = authenticate(req, pairingId);
    const body = await readJson(req);
    return send(res, 200, ackMessages(pairing, side, body.msg_ids));
  }
  throw new HttpError(404, 'not_found');
}

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, e.body);
    log('unhandled', e);
    return send(res, 500, { error: 'internal' });
  }
});

// ---------------------------------------------------------------- tier-2 proxy (spec §4, §10)
//
// One forward/CONNECT proxy for all pairings, authenticated per pairing with
// Basic proxy credentials. Both the human's login traffic (routed here by the
// extension's PAC) and the agent's later context egress from this process, so a
// session the human mints is bound to the relay's IP. Bodies are never inspected
// (CONNECT is opaque; forwarded HTTP is piped straight through) — metadata only.

function authProxy(req) {
  const h = req.headers['proxy-authorization'] || '';
  const m = /^Basic\s+(.+)$/i.exec(h);
  if (!m) return null;
  let decoded;
  try { decoded = Buffer.from(m[1].trim(), 'base64').toString('utf8'); } catch { return null; }
  const i = decoded.indexOf(':');
  if (i < 0) return null;
  const cred = proxyCreds.get(decoded.slice(0, i));
  if (!cred || cred.password !== decoded.slice(i + 1)) return null;
  return cred;
}

function logProxy(cred, method, host) {
  const arr = proxyLog.get(cred.pairing_id) || [];
  arr.push({ method, host, at: Date.now() });
  proxyLog.set(cred.pairing_id, arr.slice(-MAX_PROXY_LOG));
}

const proxyServer = http.createServer((creq, cres) => {
  const cred = authProxy(creq);
  if (!cred) {
    cres.writeHead(407, { 'proxy-authenticate': 'Basic realm="handoff"', 'content-length': 0 });
    return cres.end();
  }
  let target;
  try { target = new URL(creq.url); } catch { cres.writeHead(400); return cres.end(); }
  if (target.protocol !== 'http:') { cres.writeHead(400); return cres.end('only http absolute-URIs; https uses CONNECT'); }
  logProxy(cred, creq.method, target.host);
  const headers = { ...creq.headers };
  delete headers['proxy-authorization'];
  delete headers['proxy-connection'];
  const upstream = http.request(
    { hostname: resolveHost(target.hostname), port: target.port || 80, path: target.pathname + target.search, method: creq.method, headers },
    (ures) => { cres.writeHead(ures.statusCode || 502, ures.headers); ures.pipe(cres); },
  );
  upstream.on('error', () => { if (!cres.headersSent) cres.writeHead(502); cres.end(); });
  creq.pipe(upstream);
});

proxyServer.on('connect', (creq, clientSocket, head) => {
  const cred = authProxy(creq);
  if (!cred) {
    clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="handoff"\r\n\r\n');
    return clientSocket.end();
  }
  const [host, portStr] = creq.url.split(':');
  const port = Number(portStr) || 443;
  logProxy(cred, 'CONNECT', creq.url);
  const upstream = net.connect(port, resolveHost(host), () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on('error', () => clientSocket.destroy());
  clientSocket.on('error', () => upstream.destroy());
});

proxyServer.on('clientError', (_e, sock) => { try { sock.destroy(); } catch { /* ignore */ } });

// ---------------------------------------------------------------- websocket (extension)

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://relay');
  if (url.pathname !== '/v1/ext') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  let pairing = null;
  ws.isAlive = true;
  const authTimer = setTimeout(() => { if (!pairing) ws.close(4000, 'auth_timeout'); }, 5000);

  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return ws.close(4002, 'bad_json'); }
    if (!pairing) {
      if (msg.type !== 'auth' || typeof msg.token !== 'string') return ws.close(4003, 'auth_required');
      const t = tokens.get(msg.token);
      if (!t || t.side !== 'ext' || !pairings.has(t.pairing_id)) {
        ws.send(JSON.stringify({ type: 'error', error: 'unpaired' }));
        return ws.close(4001, 'unpaired');
      }
      clearTimeout(authTimer);
      pairing = pairings.get(t.pairing_id);
      const prev = extSockets.get(pairing.pairing_id);
      if (prev && prev !== ws) { try { prev.close(4004, 'replaced'); } catch { /* ignore */ } }
      extSockets.set(pairing.pairing_id, ws);
      ws.send(JSON.stringify({ type: 'ready', pairing_id: pairing.pairing_id }));
      log(`ext connected for pairing ${pairing.pairing_id.slice(0, 8)}`);
      pushToExtension(pairing);
      return;
    }
    switch (msg.type) {
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        break;
      case 'ack':
        ackMessages(pairing, 'ext', Array.isArray(msg.msg_ids) ? msg.msg_ids : [msg.msg_id]);
        break;
      case 'send': {
        try {
          const env = validateEnvelope(msg.envelope, pairing, 'ext');
          const r = enqueue(pairing, 'ext', env);
          ws.send(JSON.stringify({ type: 'sent', msg_id: r.msg_id, duplicate: r.duplicate }));
        } catch (e) {
          ws.send(JSON.stringify({ type: 'error', error: e.message, msg_id: msg.envelope?.msg_id }));
        }
        break;
      }
      default:
        ws.send(JSON.stringify({ type: 'error', error: 'unknown_type' }));
    }
  });
  ws.on('close', () => {
    clearTimeout(authTimer);
    if (pairing && extSockets.get(pairing.pairing_id) === ws) {
      extSockets.delete(pairing.pairing_id);
      log(`ext disconnected for pairing ${pairing.pairing_id.slice(0, 8)}`);
    }
  });
  ws.on('error', () => { /* handled by close */ });
});

const pingInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 30 * 1000);
pingInterval.unref();

loadState();
server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT} (ws: /v1/ext, state: ${STATE_FILE || 'memory only'})`);
});
proxyServer.listen(PROXY_PORT, HOST, () => {
  log(`tier-2 proxy on http://${PROXY_ADDR} (CONNECT + forward, per-pairing Basic auth)`);
});
