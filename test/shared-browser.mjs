// Shared-browser mode test: one persistent Chrome that agents attach to over CDP,
// with credentials injected via the CLI's `browser` and `load` commands. Uses
// Playwright's bundled Chromium as the browser binary and to verify as an agent.
//
//   node test/shared-browser.mjs

import { spawnSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(ROOT, 'skills', 'browser-auth-handoff', 'scripts', 'handoff', 'browser-handoff.mjs');
const SITE_PORT = 15877;
const CDP_PORT = 19345;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const TMP = path.join(ROOT, 'test', '.tmp', `sb-${Date.now()}`);
const HOME = path.join(TMP, 'home');
fs.mkdirSync(HOME, { recursive: true });

const env = { ...process.env, HANDOFF_HOME: HOME, BROWSER_HANDOFF_CHROME: chromium.executablePath() };
const log = (...a) => console.log('[shared-browser]', ...a);
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) throw new Error(`check failed: ${name} ${detail}`);
}
function cli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

const site = spawn(process.execPath, [path.join(ROOT, 'testsite', 'server.js')], { env: { ...process.env, PORT: String(SITE_PORT) }, stdio: 'ignore' });
let browser;
try {
  await new Promise((r) => setTimeout(r, 700));

  // 1. start the shared browser
  const start = cli(['browser', 'start', '--port', String(CDP_PORT), '--headless']);
  const startJson = JSON.parse(start.out.split('\n').pop());
  check('browser start reports a CDP endpoint', start.code === 0 && startJson.endpoint === `http://127.0.0.1:${CDP_PORT}`, start.err);

  const status = cli(['browser', 'status', '--port', String(CDP_PORT)]);
  check('browser status shows running', JSON.parse(status.out.split('\n').pop()).running === true);

  // 2. build real session bundles from the test site
  const cRes = await fetch(`${SITE}/cookie/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'user=alice&password=wonderland', redirect: 'manual' });
  const sid = (cRes.headers.get('set-cookie') || '').match(/sid=([^;]+)/)[1];
  const cookieBundle = path.join(TMP, 'cookie.json');
  fs.writeFileSync(cookieBundle, JSON.stringify({ version: 1, origins: [SITE], cookies: [{ name: 'sid', value: sid, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }], origins_storage: [], env: {} }));

  const lRes = await (await fetch(`${SITE}/ls/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: 'alice', password: 'wonderland' }) })).json();
  const lsBundle = path.join(TMP, 'ls.json');
  fs.writeFileSync(lsBundle, JSON.stringify({ version: 1, origins: [SITE], cookies: [], origins_storage: [{ origin: SITE, localStorage: [{ name: 'ls_token', value: lRes.token }] }], env: {} }));

  // 3. load both via the CLI
  const l1 = cli(['load', '--bundle', cookieBundle, '--port', String(CDP_PORT)]);
  check('load injects the cookie bundle', l1.code === 0 && JSON.parse(l1.out.split('\n').pop()).loaded.cookies === 1, l1.err);
  const l2 = cli(['load', '--bundle', lsBundle, '--port', String(CDP_PORT)]);
  check('load injects the localStorage bundle', l2.code === 0 && JSON.parse(l2.out.split('\n').pop()).loaded.localStorage === 1, l2.err);

  // 4. an agent attaches over CDP and finds both sessions live in the shared profile
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  const ctx = browser.contexts()[0];
  const p1 = await ctx.newPage();
  await p1.goto(`${SITE}/cookie/app`);
  await p1.waitForSelector('#ok', { timeout: 8000 }).then(() => true, () => false);
  check('attached agent is logged in on the cookie app', Boolean(await p1.$('#ok')));
  const p2 = await ctx.newPage();
  await p2.goto(`${SITE}/ls/app`);
  await p2.waitForSelector('#ok', { timeout: 8000 }).then(() => true, () => false);
  check('attached agent is logged in on the localStorage app', Boolean(await p2.$('#ok')));
  await browser.close();
  browser = null;

  // 5. stop
  const stop = cli(['browser', 'stop', '--port', String(CDP_PORT)]);
  check('browser stop succeeds', stop.code === 0);
} catch (e) {
  results.push({ name: 'run', ok: false });
  console.error('[shared-browser] ERROR', e.stack || e.message);
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  cli(['browser', 'stop', '--port', String(CDP_PORT)]);
  site.kill('SIGKILL');
}

const failed = results.filter((r) => !r.ok);
log(`${results.length - failed.length}/${results.length} checks passed${failed.length ? `; failed: ${failed.map((f) => f.name).join(', ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
