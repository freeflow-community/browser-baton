#!/usr/bin/env node
// browser-handoff — Browser Session Share CLI (spec §8, §13).
//
//   browser-handoff pair --name NAME [--relay URL]
//   browser-handoff request --origins a,b [--hint URL] [--label TEXT] [--timeout 30m] [--out FILE]
//   browser-handoff report [--request ID] --ok | --failed "reason"
//   browser-handoff status
//   browser-handoff revoke [PAIRING_ID]
//
// Exit codes (request): 0 bundle written, 2 declined, 3 timeout, 4 unpaired, 1 other error.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import * as cfg from './config.js';
import { RelayClient, RelayError } from './relay.js';
import { fingerprint, makeEnvelope, open, verifyEnvelope } from './crypto.js';
import { ensureBrowser, browserStatus, stopBrowser } from './browser.js';
import { loadBundleIntoBrowser } from './cdp.js';

const EXIT = { OK: 0, ERROR: 1, DECLINED: 2, TIMEOUT: 3, UNPAIRED: 4 };
const POLL_WAIT_S = 30;

const log = (...a) => console.error(...a);

class CliError extends Error {
  constructor(message, code = EXIT.ERROR) {
    super(message);
    this.code = code;
  }
}

function usage() {
  log(`usage:
  browser-handoff pair    --name NAME [--relay URL]
  browser-handoff request --origins a,b [--hint URL] [--label TEXT] [--timeout 30m] [--out FILE] [--tier 1|2] [--pairing ID|LABEL] [--load]
  browser-handoff report  [--request ID] (--ok | --failed "reason")
  browser-handoff proxy   --origins a,b
  browser-handoff browser <start|status|stop|endpoint> [--port N] [--profile DIR] [--chrome PATH] [--headed]
  browser-handoff load    --bundle FILE           inject a bundle into the shared browser
  browser-handoff agents                          list paired browsers
  browser-handoff use     <ID|LABEL>              set the default browser for requests
  browser-handoff status
  browser-handoff revoke  [ID|LABEL]

Shared browser: run one persistent Chrome (\`browser start\`), attach agents over CDP
(its endpoint), and use \`request --load\` so a walled login loads into it automatically.

Multi-browser: pair each browser (optionally --label NAME); target one with
--pairing <id|label>, or set a default with \`browser-handoff use\`.

env: HANDOFF_HOME (config dir, default ~/.handoff), HANDOFF_RELAY (relay URL for pair)
exit codes (request): 0 bundle, 2 declined, 3 timeout, 4 unpaired`);
}

function parseDuration(s, fallback) {
  if (!s) return fallback;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i.exec(String(s).trim());
  if (!m) throw new CliError(`bad duration: ${s}`);
  const n = Number(m[1]);
  const unit = (m[2] || 's').toLowerCase();
  return n * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit];
}

function normalizeOrigins(list) {
  const out = new Set();
  for (const raw of String(list).split(',')) {
    const s = raw.trim();
    if (!s) continue;
    let u;
    try {
      u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
    } catch {
      throw new CliError(`bad origin: ${s}`);
    }
    if (!/^https?:$/.test(u.protocol)) throw new CliError(`unsupported origin scheme: ${s}`);
    out.add(u.origin);
  }
  if (!out.size) throw new CliError('at least one origin is required');
  return [...out].sort();
}

function relayFor(pairing, flagUrl) {
  return new RelayClient(flagUrl || pairing.relay, pairing.token);
}

/** Learned tier for a set of origins (spec §8): 2 if any is a confirmed or candidate tier-2. */
function learnedTier(origins) {
  const o = cfg.loadOrigins().origins || {};
  return origins.some((origin) => o[origin]?.tier === 2 || o[origin]?.tier2_candidate) ? 2 : 1;
}

function learnOrigins(origins, patch) {
  const store = cfg.loadOrigins();
  for (const origin of origins) store.origins[origin] = { ...(store.origins[origin] || {}), ...patch, at: Math.floor(Date.now() / 1000) };
  cfg.saveOrigins(store);
}

/** Proxy settings the agent feeds to its browser context. server is a full URL. */
function proxySettings(pairing) {
  if (!pairing.proxy) return null;
  const server = /^https?:\/\//.test(pairing.proxy.server) ? pairing.proxy.server : `http://${pairing.proxy.server}`;
  return { server, username: pairing.proxy.username, password: pairing.proxy.password };
}

function requirePairing(values) {
  const pairing = cfg.currentPairing(values.pairing);
  if (!pairing) throw new CliError('not paired: run `browser-handoff pair` first', EXIT.UNPAIRED);
  return pairing;
}

function mapRelayError(e) {
  if (e instanceof RelayError) {
    if (e.unpaired) return new CliError(`unpaired: ${e.body?.error || e.status} (run \`browser-handoff pair\`)`, EXIT.UNPAIRED);
    return new CliError(e.body?.error || e.message, EXIT.ERROR);
  }
  return e;
}

// ---------------------------------------------------------------- pair

async function cmdPair(values) {
  if (!values.name || !values.name.trim()) {
    throw new CliError('--name is required (the label the human sees to identify this agent)');
  }
  const identity = cfg.loadIdentity();
  const relayUrl = values.relay || process.env.HANDOFF_RELAY || cfg.DEFAULT_RELAY;
  const relay = new RelayClient(relayUrl);
  const display_name = values.name.trim();

  const begin = await relay.beginPairing({
    agent_id: identity.agent_id,
    agent_sign_pk: identity.sign_pk,
    agent_enc_pk: identity.enc_pk,
    display_name,
  });
  const code = begin.pairing_code;
  const pretty = `${code.slice(0, 4)}-${code.slice(4)}`;
  log('');
  log(`  Pairing code:  ${pretty}`);
  log('');
  log(`  Relay:         ${relayUrl}`);
  log(`  Agent:         ${display_name}  [${fingerprint(identity.enc_pk)}]`);
  log(`  Expires:       ${new Date(begin.expires_at * 1000).toLocaleTimeString()}`);
  log('');
  log('Enter the code in the Browser Session Share extension. Waiting…');

  for (;;) {
    const r = await relay.waitPairing(code, POLL_WAIT_S);
    if (r === null) continue; // 204: still waiting
    const pairing = {
      pairing_id: r.pairing_id,
      relay: relayUrl,
      token: r.token,
      agent_id: identity.agent_id,
      label: values.label || r.ext.display_name || display_name, // local name for this browser
      ext_id: r.ext.ext_id,
      ext_enc_pk: r.ext.ext_enc_pk,
      ext_sign_pk: r.ext.ext_sign_pk,
      ext_display_name: r.ext.display_name,
      proxy: r.proxy ? { server: r.proxy.server, username: r.proxy.username, password: r.proxy.password } : null,
      created_at: r.created_at || Math.floor(Date.now() / 1000),
    };
    const previous = cfg.listPairings();
    cfg.savePairing(pairing);
    log('');
    log(`Paired with ${pairing.ext_display_name}  [${fingerprint(pairing.ext_enc_pk)}]  (label: ${pairing.label})`);
    log(`Pairing id: ${pairing.pairing_id}`);
    log('Confirm the fingerprints match on both sides.');
    if (previous.length) log(`Note: ${previous.length} other browser(s) paired. Target one with \`--pairing <id|label>\`, or \`browser-handoff use <id|label>\` to set a default. \`browser-handoff agents\` lists them.`);
    return EXIT.OK;
  }
}

// ---------------------------------------------------------------- request

async function cmdRequest(values) {
  if (!values.origins) throw new CliError('--origins is required');
  const origins = normalizeOrigins(values.origins);
  const originsKey = origins.join(',');
  const pairing = requirePairing(values);
  const relay = relayFor(pairing, values.relay);
  const identity = cfg.loadIdentity();
  const outFile = values.out || 'handoff-bundle.json';
  const timeoutMs = parseDuration(values.timeout, 30 * 60_000);
  // Tier: explicit --tier wins; otherwise use what we've learned for these origins
  // (default 1, escalating to 2 after a failed tier-1 or a confirmed tier-2).
  const tier = values.tier !== undefined ? Number(values.tier) : learnedTier(origins);
  if (tier !== 1 && tier !== 2) throw new CliError('--tier must be 1 or 2');
  if (tier === 2 && !pairing.proxy) throw new CliError('this pairing has no proxy credentials; re-pair to enable tier 2');
  const now = Math.floor(Date.now() / 1000);

  // Resume an identical pending request instead of creating a duplicate (spec §5.2, §8).
  let req = cfg
    .listPending()
    .find((p) => p.pairing_id === pairing.pairing_id && p.origins.join(',') === originsKey && p.expires_at > now);
  if (req) {
    log(`resuming pending request ${req.request_id} (expires ${new Date(req.expires_at * 1000).toLocaleTimeString()})`);
  } else {
    const request_id = crypto.randomUUID();
    const expires_at = now + Math.ceil(timeoutMs / 1000);
    const payload = {
      request_id,
      origins,
      tier,
      hint_url: values.hint || origins[0] + '/',
      task_label: values.label || 'Agent needs a session',
      expires_at,
      allow_silent: Boolean(values.silent),
    };
    const envelope = makeEnvelope({
      pairing_id: pairing.pairing_id,
      type: 'needs_session',
      payload,
      recipientPkB64: pairing.ext_enc_pk,
      signSkB64: identity.sign_sk,
    });
    req = {
      request_id,
      msg_id: envelope.msg_id,
      pairing_id: pairing.pairing_id,
      origins,
      hint_url: payload.hint_url,
      task_label: payload.task_label,
      expires_at,
      created_at: now,
      envelope,
    };
    cfg.savePending(req);
    log(`request ${request_id} for ${origins.join(', ')} (expires ${new Date(expires_at * 1000).toLocaleTimeString()})`);
  }

  // (Re)send: the relay dedupes by msg_id while queued; the extension dedupes by request_id/origins.
  try {
    await relay.postMessage(pairing.pairing_id, req.envelope);
  } catch (e) {
    throw mapRelayError(e);
  }
  log('waiting for the extension… (Ctrl-C leaves the request pending; re-run to resume)');

  process.on('SIGINT', () => {
    log('\ninterrupted; request stays pending');
    process.exit(130);
  });

  for (;;) {
    const remainingS = req.expires_at - Math.floor(Date.now() / 1000);
    if (remainingS <= 0) {
      cfg.deletePending(req.request_id);
      log(`timed out waiting for request ${req.request_id}`);
      return EXIT.TIMEOUT;
    }
    let res;
    try {
      res = await relay.pollMessages(pairing.pairing_id, Math.min(POLL_WAIT_S, remainingS));
    } catch (e) {
      const mapped = mapRelayError(e);
      if (mapped.code === EXIT.UNPAIRED) {
        cfg.deletePending(req.request_id);
        throw mapped;
      }
      log(`poll error: ${mapped.message}; retrying`);
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    const pendingIds = new Set(cfg.listPending().map((p) => p.request_id));
    const toAck = [];
    let outcome = null;
    for (const env of res?.messages || []) {
      if (env.from !== 'ext') continue;
      if (!verifyEnvelope(env, pairing.ext_sign_pk)) {
        log(`dropping message ${env.msg_id}: bad signature`);
        toAck.push(env.msg_id);
        continue;
      }
      let payload;
      try {
        payload = open(env.payload, identity.enc_sk);
      } catch (e) {
        log(`dropping undecryptable message ${env.msg_id}: ${e.message}`);
        toAck.push(env.msg_id);
        continue;
      }
      if (env.type === 'heartbeat') { toAck.push(env.msg_id); continue; }
      if (payload.request_id !== req.request_id) {
        // Belongs to another request; ack it only if nothing is waiting for it anymore.
        if (!pendingIds.has(payload.request_id)) toAck.push(env.msg_id);
        continue;
      }
      toAck.push(env.msg_id);
      if (env.type === 'session_bundle') {
        outcome = { kind: 'bundle', payload };
      } else if (env.type === 'declined') {
        outcome = { kind: 'declined', payload };
      }
    }
    if (toAck.length) {
      try { await relay.ackMessages(pairing.pairing_id, toAck); } catch (e) { log(`ack failed: ${e.message}`); }
    }
    if (!outcome) continue;

    cfg.deletePending(req.request_id);
    if (outcome.kind === 'declined') {
      log(`declined: ${outcome.payload.reason || 'user'}`);
      cfg.setLastRequest({ request_id: req.request_id, origins, outcome: 'declined', reason: outcome.payload.reason });
      return EXIT.DECLINED;
    }
    const bundle = outcome.payload.bundle;
    if (!bundle || typeof bundle !== 'object') throw new CliError('session_bundle without a bundle');
    const proxied = Boolean(outcome.payload.proxied);
    if (proxied) learnOrigins(origins, { tier: 2, tier2_candidate: false }); // confirmed: these need the proxy

    // With --load, inject straight into the shared browser and skip writing the
    // bundle to disk (unless --out was given). Otherwise write it for the caller.
    let outPath = null;
    if (values.out || !values.load) {
      fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
      fs.writeFileSync(outFile, JSON.stringify(bundle, null, 2) + '\n', { mode: 0o600 });
      outPath = path.resolve(outFile);
    }
    let loaded = null;
    let endpoint;
    if (values.load) {
      const br = await ensureBrowser(browserOpts(values));
      loaded = await loadBundleIntoBrowser(br.port, bundle);
      endpoint = br.endpoint;
      log(`loaded into the shared browser at ${endpoint}: ${loaded.cookies} cookie(s), ${loaded.localStorage} localStorage item(s)`);
      if (proxied) log('warning: this is a tier-2 (IP-bound) session; the shared browser is not proxied, so it may be rejected');
    }
    cfg.setLastRequest({ request_id: req.request_id, origins, outcome: 'bundle', out: outPath, loaded: Boolean(loaded) });
    log(`bundle: ${bundle.cookies?.length || 0} cookie(s), ${(bundle.origins_storage || []).length} origin storage record(s)${outPath ? ` → ${outPath}` : ''}${proxied ? ' (proxied)' : ''}`);
    process.stdout.write(
      JSON.stringify({
        request_id: req.request_id,
        proxied,
        proxy: proxied ? proxySettings(pairing) : undefined,
        silent: Boolean(outcome.payload.silent),
        out: outPath,
        loaded: loaded || undefined,
        endpoint,
      }) + '\n',
    );
    return EXIT.OK;
  }
}

// ---------------------------------------------------------------- report

async function cmdReport(values) {
  const last = cfg.getLastRequest();
  const request_id = values.request || last?.request_id;
  if (!request_id) throw new CliError('--request ID is required (no previous request found)');
  if (!values.ok && values.failed === undefined) throw new CliError('specify --ok or --failed "reason"');
  if (values.ok && values.failed !== undefined) throw new CliError('--ok and --failed are mutually exclusive');
  const ok = Boolean(values.ok);
  const reason = ok ? undefined : String(values.failed || 'unspecified');
  const pairing = requirePairing(values);
  const identity = cfg.loadIdentity();
  const relay = relayFor(pairing, values.relay);
  const envelope = makeEnvelope({
    pairing_id: pairing.pairing_id,
    type: 'report',
    payload: { request_id, ok, reason },
    recipientPkB64: pairing.ext_enc_pk,
    signSkB64: identity.sign_sk,
  });
  try {
    await relay.postMessage(pairing.pairing_id, envelope);
  } catch (e) {
    throw mapRelayError(e);
  }
  if (!ok && last?.request_id === request_id && Array.isArray(last.origins)) {
    // Spec §8: after a failed tier-1 attempt, mark origins as tier-2 candidates.
    const o = cfg.loadOrigins();
    for (const origin of last.origins) {
      o.origins[origin] = { ...(o.origins[origin] || {}), tier2_candidate: true, last_failure: reason, at: Math.floor(Date.now() / 1000) };
    }
    cfg.saveOrigins(o);
  }
  log(`reported ${ok ? 'ok' : `failed: ${reason}`} for request ${request_id}`);
  return EXIT.OK;
}

// ---------------------------------------------------------------- status / revoke

async function cmdProxy(values) {
  if (!values.origins) throw new CliError('--origins is required');
  const origins = normalizeOrigins(values.origins);
  const pairing = requirePairing(values);
  // Print proxy settings only if these origins are learned tier 2 (spec §8), else null.
  const out = learnedTier(origins) === 2 ? proxySettings(pairing) : null;
  process.stdout.write(JSON.stringify(out) + '\n');
  return EXIT.OK;
}

async function cmdStatus() {
  const identity = cfg.loadIdentity();
  log(`config:   ${cfg.home()}`);
  log(`agent id: ${identity.agent_id}  [${fingerprint(identity.enc_pk)}]`);
  const pairings = cfg.listPairings();
  const def = cfg.getDefaultPairing();
  if (!pairings.length) log('pairings: none (run `browser-handoff pair`)');
  for (const p of pairings) {
    let state = 'unknown';
    try {
      const s = await new RelayClient(p.relay, p.token).status(p.pairing_id);
      state = `${s.ext_connected ? 'extension online' : 'extension offline'}, queued to_ext=${s.queued.to_ext} to_agent=${s.queued.to_agent}`;
    } catch (e) {
      state = e instanceof RelayError && e.unpaired ? 'REVOKED or unknown at relay' : `relay error: ${e.message}`;
    }
    const mark = p.pairing_id === def ? '  (default)' : '';
    log(`pairing:  ${p.label || p.ext_display_name}  ${p.pairing_id.slice(0, 8)}  [${fingerprint(p.ext_enc_pk)}]  via ${p.relay}${mark}  — ${state}`);
  }
  const now = Math.floor(Date.now() / 1000);
  const pending = cfg.listPending();
  if (pending.length) {
    log('pending requests:');
    for (const r of pending) {
      const left = r.expires_at - now;
      log(`  ${r.request_id}  ${r.origins.join(', ')}  ${left > 0 ? `${Math.ceil(left / 60)}m left` : 'expired'}`);
    }
  }
  const origins = cfg.loadOrigins();
  const learned = Object.entries(origins.origins || {});
  if (learned.length) {
    log('learned origins:');
    for (const [o, v] of learned) log(`  ${o}  ${v.tier2_candidate ? 'tier-2 candidate' : ''} ${v.last_failure ? `(last failure: ${v.last_failure})` : ''}`);
  }
  return EXIT.OK;
}

async function cmdRevoke(values, positional) {
  const pairing = requirePairing({ pairing: positional[0] || values.pairing });
  try {
    await new RelayClient(pairing.relay, pairing.token).revoke(pairing.pairing_id);
    log(`revoked ${pairing.label || pairing.pairing_id} at relay`);
  } catch (e) {
    log(`relay revoke failed (${e.message}); removing local record anyway`);
  }
  cfg.deletePairing(pairing.pairing_id);
  if (cfg.getDefaultPairing() === pairing.pairing_id) cfg.setDefaultPairing(''); // clear stale default
  for (const p of cfg.listPending()) if (p.pairing_id === pairing.pairing_id) cfg.deletePending(p.request_id);
  return EXIT.OK;
}

// Options for the shared browser supervisor.
function browserOpts(values) {
  return {
    port: values.port ? Number(values.port) : undefined,
    profile: values.profile,
    chrome: values.chrome,
    headless: values.headed ? false : (values.headless ? true : undefined),
  };
}

async function cmdBrowser(values, positional) {
  const sub = positional[0] || 'status';
  if (sub === 'start') {
    const br = await ensureBrowser(browserOpts(values));
    log(`shared browser ${br.alreadyRunning ? 'already running' : 'started'} at ${br.endpoint} (profile: ${br.profile})`);
    process.stdout.write(JSON.stringify({ endpoint: br.endpoint, port: br.port, profile: br.profile }) + '\n');
    return EXIT.OK;
  }
  if (sub === 'status') {
    const s = await browserStatus();
    log(s.running ? `running at ${s.endpoint} (profile: ${s.profile})` : 'not running');
    process.stdout.write(JSON.stringify(s) + '\n');
    return EXIT.OK;
  }
  if (sub === 'endpoint') {
    const s = await browserStatus();
    if (!s.running) throw new CliError('shared browser not running (run `browser-handoff browser start`)');
    process.stdout.write(s.endpoint + '\n');
    return EXIT.OK;
  }
  if (sub === 'stop') {
    stopBrowser();
    log('shared browser stopped');
    return EXIT.OK;
  }
  throw new CliError(`unknown browser subcommand: ${sub} (start|status|stop|endpoint)`);
}

async function cmdLoad(values) {
  const file = values.bundle || values.out || cfg.getLastRequest()?.out;
  if (!file) throw new CliError('--bundle FILE is required (or a previous request with --out)');
  let bundle;
  try { bundle = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { throw new CliError(`could not read bundle ${file}: ${e.message}`); }
  const br = await ensureBrowser(browserOpts(values));
  const loaded = await loadBundleIntoBrowser(br.port, bundle);
  log(`loaded ${file} into the shared browser at ${br.endpoint}: ${loaded.cookies} cookie(s), ${loaded.localStorage} localStorage item(s)`);
  process.stdout.write(JSON.stringify({ endpoint: br.endpoint, loaded }) + '\n');
  return EXIT.OK;
}

async function cmdUse(values, positional) {
  const pairing = requirePairing({ pairing: positional[0] || values.pairing });
  cfg.setDefaultPairing(pairing.pairing_id);
  log(`default pairing set to ${pairing.label || pairing.ext_display_name} (${pairing.pairing_id})`);
  return EXIT.OK;
}

// ---------------------------------------------------------------- main

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      relay: { type: 'string' },
      pairing: { type: 'string' },
      origins: { type: 'string' },
      hint: { type: 'string' },
      label: { type: 'string' },
      timeout: { type: 'string' },
      out: { type: 'string' },
      tier: { type: 'string' },
      silent: { type: 'boolean' },
      request: { type: 'string' },
      ok: { type: 'boolean' },
      failed: { type: 'string' },
      load: { type: 'boolean' },        // inject the bundle into the shared browser
      bundle: { type: 'string' },       // bundle file for `load`
      port: { type: 'string' },         // shared browser CDP port
      profile: { type: 'string' },      // shared browser user-data-dir
      chrome: { type: 'string' },       // path to the Chrome binary
      headless: { type: 'boolean' },
      headed: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [cmd, ...rest] = positionals;
  if (values.help || !cmd) {
    usage();
    return cmd ? EXIT.OK : EXIT.ERROR;
  }
  switch (cmd) {
    case 'pair': return cmdPair(values);
    case 'request': return cmdRequest(values);
    case 'report': return cmdReport(values);
    case 'proxy': return cmdProxy(values);
    case 'browser': return cmdBrowser(values, rest);
    case 'load': return cmdLoad(values);
    case 'status': case 'agents': return cmdStatus(values);
    case 'use': return cmdUse(values, rest);
    case 'revoke': return cmdRevoke(values, rest);
    default:
      usage();
      throw new CliError(`unknown command: ${cmd}`);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    const err = mapRelayError(e);
    log(`browser-handoff: ${err.message}`);
    process.exit(err.code || EXIT.ERROR);
  });
