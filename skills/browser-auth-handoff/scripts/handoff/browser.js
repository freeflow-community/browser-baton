// Shared browser supervisor: one long-lived Chrome on the box with a persistent
// profile and remote debugging, that agents attach to over CDP. Its profile
// keeps the session across restarts, so credentials load once, not per request.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as cfg from './config.js';
import { cdpAlive } from './cdp.js';

const DEFAULT_PORT = Number(process.env.BROWSER_HANDOFF_PORT || 9222);

function chromeCandidates() {
  return [
    process.env.BROWSER_HANDOFF_CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ].filter(Boolean);
}

function findChrome(explicit) {
  for (const p of [explicit, ...chromeCandidates()]) if (p && fs.existsSync(p)) return p;
  return null;
}

const stateFile = () => path.join(cfg.home(), 'browser.json');
export function browserState() { return cfg.readJson(stateFile()); }
function saveState(s) { cfg.writeJson(stateFile(), s); }
function clearState() { try { fs.unlinkSync(stateFile()); } catch { /* ignore */ } }

/** Ensure the shared Chrome is running; returns { port, endpoint, profile, pid, alreadyRunning }. */
export async function ensureBrowser(opts = {}) {
  const port = Number(opts.port || (browserState()?.port) || DEFAULT_PORT);
  if (await cdpAlive(port)) {
    const st = browserState() || {};
    return { port, endpoint: `http://127.0.0.1:${port}`, profile: st.profile, pid: st.pid, alreadyRunning: true };
  }
  const profile = opts.profile || browserState()?.profile || path.join(cfg.home(), 'browser-profile');
  const chrome = findChrome(opts.chrome);
  if (!chrome) {
    throw new Error('no Chrome/Chromium found; set BROWSER_HANDOFF_CHROME to its path');
  }
  fs.mkdirSync(profile, { recursive: true });
  const headless = opts.headless ?? (String(process.env.BROWSER_HANDOFF_HEADLESS ?? 'true') !== 'false');
  const args = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
  ];
  if (headless) args.push('--headless=new');
  const child = spawn(chrome, args, { detached: true, stdio: 'ignore' });
  child.unref();
  saveState({ port, pid: child.pid, profile, chrome, headless, started_at: Math.floor(Date.now() / 1000) });
  // Wait for the CDP endpoint to come up.
  for (let i = 0; i < 100; i++) {
    if (await cdpAlive(port)) return { port, endpoint: `http://127.0.0.1:${port}`, profile, pid: child.pid, alreadyRunning: false };
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`shared browser did not expose CDP on port ${port} within 10s`);
}

export async function browserStatus() {
  const st = browserState();
  const port = st?.port || DEFAULT_PORT;
  const running = await cdpAlive(port);
  return { running, port, endpoint: running ? `http://127.0.0.1:${port}` : null, profile: st?.profile, pid: st?.pid };
}

export function stopBrowser() {
  const st = browserState();
  if (st?.pid) { try { process.kill(st.pid); } catch { /* already gone */ } }
  clearState();
  return { stopped: Boolean(st?.pid) };
}
