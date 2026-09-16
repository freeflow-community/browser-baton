// End-to-end test of the MVP success criteria (spec §13) with the real extension
// loaded into a Playwright-controlled Chromium that plays the "human's Chrome".
//
//   node test/e2e.mjs            (headless; HEADED=1 to watch)
//
// Criteria covered:
//   1. Pair once; the extension stays connected across a Chrome restart.
//   2. Cookie-auth site: the agent sim reports ok and loads an authenticated page.
//   3. localStorage-token site: same.
//   4. Kill the agent mid-request, re-run `request`: the pending request resumes, no duplicate.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXT_DIR = path.join(ROOT, 'extension');
const HANDOFF = path.join(ROOT, 'cli', 'bin', 'handoff.js');
const AGENT_SIM = path.join(ROOT, 'test', 'agent-sim.mjs');
const RELAY_PORT = 18787;
const PROXY_PORT = 18788;
const SITE_PORT = 14321;
const RELAY = `http://127.0.0.1:${RELAY_PORT}`;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
// Tier-2 uses a distinct site hostname (mapped to loopback) so the extension's PAC
// routes only the site through the proxy, not the relay's own 127.0.0.1 traffic.
const TIER2_HOST = 'site.test';
const TIER2_SITE = `http://${TIER2_HOST}:${SITE_PORT}`;
const HEADLESS = !process.env.HEADED;
const TMP = path.join(ROOT, 'test', '.tmp', String(Date.now()));
const HOME = path.join(TMP, 'handoff-home');
const PROFILE = path.join(TMP, 'chrome-profile');
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(PROFILE, { recursive: true });

const children = new Set();
const log = (...a) => console.log('[e2e]', ...a);

function run(name, args, { env = {}, cwd = ROOT } = {}) {
  const proc = spawn(process.execPath, args, { cwd, env: { ...process.env, HANDOFF_HOME: HOME, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(proc);
  let stdout = '', stderr = '';
  proc.stdout.on('data', (d) => { stdout += d; });
  proc.stderr.on('data', (d) => { stderr += d; for (const line of String(d).trimEnd().split('\n')) console.log(`  [${name}] ${line}`); });
  const done = new Promise((resolve) => proc.on('exit', (code, signal) => { children.delete(proc); resolve({ code, signal, stdout, stderr }); }));
  return { proc, done, get stderr() { return stderr; }, get stdout() { return stdout; } };
}

async function waitFor(fn, { timeout = 30_000, interval = 250, what = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

async function waitHttp(url, what) {
  await waitFor(() => fetch(url).then((r) => r.ok, () => false), { what });
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) throw new Error(`check failed: ${name} ${detail}`);
}

// ---------------------------------------------------------------- browser helpers

let context = null;
let extId = null;

async function launchChrome() {
  context = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chromium',
    headless: HEADLESS,
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      `--host-resolver-rules=MAP ${TIER2_HOST} 127.0.0.1`,
    ],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 20_000 });
  extId = new URL(sw.url()).host;
  return context;
}

async function openPopup() {
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`  [popup:error] ${e.message}`));
  await page.goto(`chrome-extension://${extId}/popup.html`);
  return page;
}

async function popupState(page) {
  // Ask the service worker directly, through the popup's chrome.runtime.
  return page.evaluate(() => new Promise((res) => chrome.runtime.sendMessage({ type: 'getState' }, (r) => res(r?.result))));
}

async function pendingRequests(page) {
  const s = await popupState(page);
  return Object.values(s.requests).filter((r) => r.state === 'pending' || r.state === 'started');
}

async function clickDone(page) {
  const card = await waitFor(async () => {
    const cards = await page.$$('.request');
    for (const c of cards) {
      const btn = await c.$('button.done');
      if (btn && (await btn.isVisible())) return c;
    }
    return null;
  }, { what: 'a pending request card in the popup' });
  await (await card.$('button.done')).click();
  await page.waitForSelector('.request.sent, .request.reported-ok, .request.reported-bad', { timeout: 30_000 });
}

async function humanLogin(pathname) {
  const page = await context.newPage();
  await page.goto(SITE + pathname);
  await page.fill('input[type=password]', 'wonderland');
  await page.click('button[type=submit]');
  await page.waitForSelector('#ok', { timeout: 10_000 });
  await page.close();
}

// ---------------------------------------------------------------- main

let relay, site;
try {
  relay = run('relay', [path.join(ROOT, 'relay', 'server.js')], { env: { PORT: String(RELAY_PORT), PROXY_PORT: String(PROXY_PORT), RELAY_PROXY_ADDR: `127.0.0.1:${PROXY_PORT}`, RELAY_PROXY_RESOLVE: `${TIER2_HOST}=127.0.0.1`, RELAY_STATE_FILE: path.join(TMP, 'relay-state.json') } });
  site = run('site', [path.join(ROOT, 'testsite', 'server.js')], { env: { PORT: String(SITE_PORT) } });
  await waitHttp(`${RELAY}/healthz`, 'relay');
  await waitHttp(`${SITE}/`, 'test site');

  await launchChrome();
  log(`extension id ${extId}`);

  // ---- 1a. pair
  const pair = run('pair', [HANDOFF, 'pair', '--relay', RELAY, '--name', 'e2e-agent']);
  const code = await waitFor(() => /Pairing code:\s+([A-Z2-9]{4}-[A-Z2-9]{4})/.exec(pair.stderr)?.[1], { what: 'pairing code' });
  let popup = await openPopup();
  await popup.fill('#relay', RELAY);
  await popup.fill('#code', code);
  await popup.click('#pair-btn');
  await popup.waitForSelector('.agent', { timeout: 15_000 });
  const pairRes = await pair.done;
  check('pair: CLI exits 0 after the extension accepts', pairRes.code === 0, `exit ${pairRes.code}`);
  await waitFor(() => popup.$('#summary-dot.online'), { what: 'extension online' });
  check('pair: extension connected to relay', true);
  const st = await popupState(popup);
  const firstAgent = st.agents?.[0];
  check('pair: extension shows the agent name', firstAgent?.agent?.display_name === 'e2e-agent', firstAgent?.agent?.display_name);

  // ---- 2. cookie-based site
  await humanLogin('/cookie/app');
  let agent = run('agent', [AGENT_SIM, `${SITE}/cookie/app`, '--success', '#ok', '--timeout', '2m', '--out', path.join(TMP, 'cookie-bundle.json')]);
  // The service worker should auto-open a request window (not just a badge).
  const reqWindow = await waitFor(
    () => context.pages().find((pg) => pg.url().includes('popup.html?window=1')),
    { what: 'auto-opened request window' },
  ).catch(() => null);
  check('request: extension auto-opens a window on a request', Boolean(reqWindow));
  await clickDone(popup);
  let hr = await agent.done;
  check('cookie site: agent lands past the login', hr.code === 0 && /ok: landed past the login/.test(hr.stderr), `exit ${hr.code}`);
  const cookieBundle = JSON.parse(fs.readFileSync(path.join(TMP, 'cookie-bundle.json'), 'utf8'));
  check('cookie site: bundle carries the HttpOnly sid cookie', cookieBundle.cookies.some((c) => c.name === 'sid' && c.httpOnly));
  await waitFor(() => popup.$('.request.reported-ok'), { what: 'report ✓ in popup' });
  check('cookie site: extension shows the agent report ✓', true);

  // ---- 3. localStorage-token site
  await humanLogin('/ls/app');
  agent = run('agent', [AGENT_SIM, `${SITE}/ls/app`, '--success', '#ok', '--timeout', '2m', '--out', path.join(TMP, 'ls-bundle.json')]);
  await clickDone(popup);
  hr = await agent.done;
  check('localStorage site: agent lands past the login', hr.code === 0 && /ok: landed past the login/.test(hr.stderr), `exit ${hr.code}`);
  const lsBundle = JSON.parse(fs.readFileSync(path.join(TMP, 'ls-bundle.json'), 'utf8'));
  check('localStorage site: bundle carries ls_token', lsBundle.origins_storage.some((o) => o.localStorage.some((e) => e.name === 'ls_token')));

  // ---- 4. kill mid-request, re-run, resume without duplicate
  const reqArgs = [HANDOFF, 'request', '--origins', SITE, '--hint', `${SITE}/cookie/app`, '--label', 'resume test', '--timeout', '5m', '--out', path.join(TMP, 'resume-bundle.json')];
  const first = run('request#1', reqArgs);
  await waitFor(async () => (await pendingRequests(popup)).some((r) => r.task_label === 'resume test'), { what: 'first request in popup' });
  first.proc.kill('SIGKILL');
  await first.done;
  const second = run('request#2', reqArgs);
  await waitFor(() => /resuming pending request/.test(second.stderr), { what: 'CLI to resume' });
  await new Promise((r) => setTimeout(r, 1500));
  const pending = (await pendingRequests(popup)).filter((r) => r.task_label === 'resume test');
  check('resume: exactly one pending request after re-run', pending.length === 1, `${pending.length} pending`);
  await clickDone(popup);
  const sr = await second.done;
  check('resume: resumed request receives the bundle', sr.code === 0 && fs.existsSync(path.join(TMP, 'resume-bundle.json')), `exit ${sr.code}`);
  run('report', [HANDOFF, 'report', '--ok']);

  // ---- 1b. survives a Chrome restart without re-pairing
  await popup.close();
  await context.close();
  await launchChrome();
  popup = await openPopup();
  await popup.waitForSelector('.agent', { timeout: 15_000 });
  await waitFor(() => popup.$('#summary-dot.online'), { what: 'extension online after restart' });
  const relayStatus = await fetch(`${RELAY}/v1/pairings/${firstAgent.pairing_id}`, { headers: { authorization: `Bearer ${JSON.parse(fs.readFileSync(path.join(HOME, 'pairings', `${firstAgent.pairing_id}.json`), 'utf8')).token}` } }).then((r) => r.json());
  check('restart: extension reconnects with the same pairing', relayStatus.ext_connected === true && relayStatus.pairing_id === firstAgent.pairing_id);

  // ---- 5. tier 2: login + agent traffic both egress through the relay proxy
  const agent2 = run('agent#tier2', [AGENT_SIM, `${TIER2_SITE}/cookie/app`, '--tier', '2', '--success', '#ok', '--timeout', '2m', '--out', path.join(TMP, 'tier2-bundle.json')]);
  // Human clicks Start (this applies the PAC), logs in in the opened tab, clicks Done.
  // Only the pending tier-2 request shows a visible Start; resolved cards hide it.
  const startBtn = await waitFor(async () => {
    const s = await popup.$('.request button.start');
    return s && (await s.isVisible()) ? s : null;
  }, { what: 'Start button for the tier-2 request' });
  await startBtn.click();
  // The Start opens the hint URL in a new tab; log in there.
  const loginTab = await waitFor(
    () => context.pages().find((pg) => pg.url().includes(`${TIER2_HOST}:${SITE_PORT}`)) || null,
    { what: 'login tab on site.test opened by Start', timeout: 15_000 },
  ).catch(async () => {
    const urls = context.pages().map((p) => p.url());
    const mode = await popup.evaluate(() => new Promise((res) => chrome.proxy.settings.get({}, (c) => res(c.value?.mode)))).catch(() => '?');
    const cardText = await popup.$eval('.request', (el) => el.innerText).catch(() => '(no card)');
    log(`DEBUG tier2: pages=${JSON.stringify(urls)} proxyMode=${mode} card="${cardText.replace(/\n/g, ' ')}"`);
    throw new Error('login tab not opened');
  });
  await loginTab.waitForLoadState('load').catch(() => {});
  await loginTab.fill('input[type=password]', 'wonderland');
  await loginTab.click('button[type=submit]');
  await loginTab.waitForSelector('#ok', { timeout: 10_000 });
  // Proxy should be applied while the request is in flight.
  const proxyMode = await popup.evaluate(() => new Promise((res) => chrome.proxy.settings.get({}, (c) => res(c.value?.mode))));
  check('tier 2: extension applied a PAC proxy during login', proxyMode === 'pac_script', `mode ${proxyMode}`);
  // Complete via the in-page panel injected onto the login tab (not the popup window).
  const panelDone = loginTab.getByRole('button', { name: /Done/ });
  await panelDone.waitFor({ state: 'visible', timeout: 10_000 });
  check('tier 2: in-page Done panel appears on the login tab', true);
  await panelDone.click();
  await loginTab.getByText(/Session sent/).waitFor({ timeout: 30_000 });
  check('tier 2: in-page panel confirms the session was sent', true);
  const a2 = await agent2.done;
  check('tier 2: agent lands past login via the proxy', a2.code === 0 && /ok: landed past the login/.test(a2.stderr), `exit ${a2.code}`);

  // The relay proxy should have carried traffic for the site host from this pairing.
  const pairingToken = JSON.parse(fs.readFileSync(path.join(HOME, 'pairings', `${firstAgent.pairing_id}.json`), 'utf8')).token;
  const relayStatus2 = await fetch(`${RELAY}/v1/pairings/${firstAgent.pairing_id}`, { headers: { authorization: `Bearer ${pairingToken}` } }).then((r) => r.json());
  const proxied = (relayStatus2.proxy?.recent || []).filter((e) => String(e.host).includes(TIER2_HOST));
  check('tier 2: relay proxy carried the site traffic', proxied.length >= 1, `${proxied.length} proxied event(s)`);

  // After Done the PAC is cleared.
  await waitFor(async () => (await popup.evaluate(() => new Promise((res) => chrome.proxy.settings.get({}, (c) => res(c.value?.mode))))) !== 'pac_script', { what: 'proxy cleared after Done' });
  check('tier 2: extension cleared the proxy after Done', true);

  // CLI learned these origins are tier 2.
  const proxyOut = run('proxy-learned', [HANDOFF, 'proxy', '--origins', TIER2_SITE]);
  const po = await proxyOut.done;
  check('tier 2: `handoff proxy` reports proxy for learned origin', /"server"/.test(po.stdout), po.stdout.trim());

  // ---- signatures: Node crypto and the extension crypto must interoperate (spec §5)
  const nodeCrypto = await import(new URL('../cli/src/crypto.js', import.meta.url));
  const nacl = (await import('tweetnacl')).default;
  const kp = nacl.sign.keyPair();
  const nodePk = Buffer.from(kp.publicKey).toString('base64');
  const nodeEnv = { v: 1, pairing_id: 'x', msg_id: 'm1', type: 'needs_session', ts: 123, from: 'agent', payload: 'Zm9v', sig: '' };
  nodeCrypto.signEnvelope(nodeEnv, Buffer.from(kp.secretKey).toString('base64'));
  const extCheck = await popup.evaluate(({ env, pk }) => ({
    ok: HandoffCommon.verifyEnvelope(env, pk),
    tampered: HandoffCommon.verifyEnvelope({ ...env, ts: env.ts + 1 }, pk),
  }), { env: nodeEnv, pk: nodePk });
  check('signatures: extension verifies a Node-signed envelope', extCheck.ok === true);
  check('signatures: extension rejects a tampered envelope', extCheck.tampered === false);
  const extSigned = await popup.evaluate(() => {
    const k = nacl.sign.keyPair();
    const env = { v: 1, pairing_id: 'x', msg_id: 'm2', type: 'report', ts: 456, from: 'ext', payload: 'YmFy', sig: '' };
    HandoffCommon.signEnvelope(env, HandoffCommon.b64.encode(k.secretKey));
    return { env, pk: HandoffCommon.b64.encode(k.publicKey) };
  });
  check('signatures: Node verifies an extension-signed envelope', nodeCrypto.verifyEnvelope(extSigned.env, extSigned.pk) === true);

  // ---- 6. multiple agents on one browser (multi-agent-spec Phase 1)
  const HOME2 = path.join(TMP, 'handoff-home-2');
  fs.mkdirSync(HOME2, { recursive: true });
  const pair2 = run('pair2', [HANDOFF, 'pair', '--relay', RELAY, '--name', 'e2e-agent-2'], { env: { HANDOFF_HOME: HOME2 } });
  const code2 = await waitFor(() => /Pairing code:\s+([A-Z2-9]{4}-[A-Z2-9]{4})/.exec(pair2.stderr)?.[1], { what: 'second pairing code' });
  await popup.click('#add-toggle');
  await popup.fill('#relay', RELAY);
  await popup.fill('#code', code2);
  await popup.fill('#label', 'second agent');
  await popup.click('#pair-btn');
  await waitFor(async () => (await popup.$$('.agent')).length >= 2, { what: 'a second agent row' });
  await pair2.done;
  const st2 = await popupState(popup);
  check('multi-agent: two distinct agents registered on one browser', new Set(st2.agents.map((a) => a.agent.agent_id)).size === 2, `${st2.agents.length} agents`);

  // A request from the second agent must be attributed to it, not the first.
  // (The profile is still logged into the cookie app from step 2, so no re-login.)
  const agentB = run('agent2', [AGENT_SIM, `${SITE}/cookie/app`, '--success', '#ok', '--timeout', '2m', '--out', path.join(TMP, 'a2-bundle.json')], { env: { HANDOFF_HOME: HOME2 } });
  const a2req = await waitFor(async () => (await pendingRequests(popup)).find((r) => /agent-2|second agent/i.test(r.agent_name || '')), { what: 'a request attributed to the second agent' });
  check('multi-agent: request identifies the requesting agent', /agent-2|second agent/i.test(a2req.agent_name), a2req.agent_name);
  await clickDone(popup);
  const aB = await agentB.done;
  check('multi-agent: the second agent receives its bundle', aB.code === 0 && /ok: landed past the login/.test(aB.stderr), `exit ${aB.code}`);

  // Revoking one agent leaves the other registered and connected.
  const revokeBtn = await waitFor(async () => {
    for (const row of await popup.$$('.agent')) {
      const nm = await row.$eval('.name', (el) => el.textContent).catch(() => '');
      if (/second agent|agent-2/i.test(nm)) return row.$('button.revoke');
    }
    return null;
  }, { what: 'revoke button for the second agent' });
  await revokeBtn.click();
  await waitFor(async () => (await popup.$$('.agent')).length === 1, { what: 'the second agent to be removed' });
  const st3 = await popupState(popup);
  check('multi-agent: revoking one agent leaves the other', st3.agents.length === 1 && st3.agents[0].agent.display_name === 'e2e-agent');

  // ---- decline path
  const dec = run('request#decline', [HANDOFF, 'request', '--origins', SITE, '--label', 'decline test', '--timeout', '2m', '--out', path.join(TMP, 'never.json')]);
  await waitFor(() => popup.$('.request button.decline'), { what: 'decline button' });
  await popup.click('.request button.decline');
  const dr = await dec.done;
  check('decline: CLI exits 2', dr.code === 2, `exit ${dr.code}`);

  await popup.close();
} catch (e) {
  results.push({ name: 'run', ok: false, detail: e.message });
  console.error('[e2e] ERROR', e.stack || e.message);
} finally {
  try { await context?.close(); } catch { /* ignore */ }
  for (const c of children) c.kill('SIGKILL');
}

const failed = results.filter((r) => !r.ok);
log(`${results.length - failed.length}/${results.length} checks passed${failed.length ? `; failed: ${failed.map((f) => f.name).join(', ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
