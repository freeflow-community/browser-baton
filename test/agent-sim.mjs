#!/usr/bin/env node
// Agent simulator — the scripted "agent" the e2e suite drives so it can exercise
// the full stack without a real LLM in the loop. A real agent does this itself,
// following the `browser-auth-handoff` skill; this is not a component anyone runs
// by hand. It runs the loop the skill describes: request a session, import the
// bundle, reload, verify (the agent's own judgment), and report.
//
//   node test/agent-sim.mjs <url> [--origins a,b] [--success SELECTOR]
//                                 [--label TEXT] [--timeout 15m] [--headed] [--out FILE]
//
// --success is an optional selector that only exists when logged in; if given, it is
// used to decide success, otherwise it reports whether the final URL
// still looks like a login/authwall page.
//
// Exit: 0 authenticated, 2 declined, 3 timeout, 4 unpaired, 5 imported but still walled, 1 error.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { newContextFromBundle, loadBundle } from '../skills/browser-auth-handoff/scripts/import-bundle.mjs';

const HANDOFF = fileURLToPath(new URL('../cli/bin/handoff.js', import.meta.url));
const log = (...a) => console.error('[agent-sim]', ...a);

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    origins: { type: 'string' },
    success: { type: 'string' },
    label: { type: 'string' },
    timeout: { type: 'string', default: '15m' },
    tier: { type: 'string' },
    headed: { type: 'boolean', default: false },
    out: { type: 'string' },
  },
});
const url = positionals[0];
if (!url) {
  log('usage: agent-sim.mjs <url> [--origins a,b] [--success SELECTOR] [--headed]');
  process.exit(1);
}

function handoff(args) {
  const r = spawnSync(process.execPath, [HANDOFF, ...args], { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
  return { code: r.status ?? 1, stdout: r.stdout || '' };
}

// The agent's verification step: did we land past the wall?
async function pastWall(page) {
  await page.waitForLoadState('load').catch(() => {});
  if (values.success) {
    return page.waitForSelector(values.success, { timeout: 3000, state: 'visible' }).then(() => true, () => false);
  }
  const loggedOutUrl = /\/(login|authwall|checkpoint|signin|sign_in|uas\/login)/i.test(page.url());
  const passwordField = await page.$('input[type=password], input[name=session_password]');
  return !loggedOutUrl && !passwordField;
}

const browser = await chromium.launch({ headless: !values.headed });
let exitCode = 1;
try {
  const target = new URL(url);
  const origins = [target.origin, ...(values.origins ? values.origins.split(',') : [])].map((s) => s.trim()).filter(Boolean);
  const outFile = values.out || path.join(path.dirname(fileURLToPath(import.meta.url)), `bundle-${Date.now()}.json`);

  log(`requesting a session for ${origins.join(', ')} (hint ${url})`);
  const reqArgs = ['request', '--origins', origins.join(','), '--hint', url,
    '--label', values.label || `Agent: ${target.hostname}`, '--timeout', values.timeout, '--out', outFile];
  if (values.tier) reqArgs.push('--tier', values.tier);
  const req = handoff(reqArgs);
  if (req.code !== 0) {
    log(`handoff request exited ${req.code} (${{ 2: 'declined', 3: 'timeout', 4: 'unpaired' }[req.code] || 'error'})`);
    exitCode = req.code;
  } else {
    const res = JSON.parse(req.stdout.trim().split('\n').pop());
    const bundle = loadBundle(outFile);
    log(`bundle received: ${bundle.cookies.length} cookie(s), ${bundle.origins_storage.reduce((n, o) => n + (o.localStorage?.length || 0), 0)} localStorage item(s)${res.proxied ? ' — via relay proxy (tier 2)' : ''}`);
    // Tier 2: the agent reuses the same proxy the session was minted through (spec §9).
    const ctx = await newContextFromBundle(browser, bundle, res.proxied && res.proxy ? { proxy: res.proxy } : {});
    const page = await ctx.newPage();
    await page.goto(url);
    const ok = await pastWall(page);
    const title = await page.title();
    await ctx.close();
    if (ok) {
      log(`ok: landed past the login (page title: "${title}")`);
      handoff(['report', '--request', res.request_id, '--ok']);
      exitCode = 0;
    } else {
      log(`still walled after import (page title: "${title}", url: ${page.url()})`);
      handoff(['report', '--request', res.request_id, '--failed', 'still on login page after importing bundle']);
      exitCode = 5;
    }
  }
} catch (e) {
  log(e.stack || e.message);
  exitCode = 1;
} finally {
  await browser.close();
}
process.exit(exitCode);
