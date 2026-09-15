// Reusable importer: apply a Session Handoff bundle (spec §6) to a Playwright
// browser context. Import as a library, or run directly to verify a bundle.
//
//   import { newContextFromBundle, importIntoContext, bundleCookies } from './import-bundle.mjs'
//
//   const ctx = await newContextFromBundle(browser, bundle);   // fresh context with env mirrored
//   // ...or apply to a context you already made:
//   await importIntoContext(ctx, bundle);
//
// CLI (self-test):
//   node import-bundle.mjs <bundle.json> <url> [--headed] [--dump-title]
//     exit 0 = page loaded; prints the final URL and <title>.

import fs from 'node:fs';

/** Bundle cookies -> Playwright addCookies() shape. */
export function bundleCookies(bundle) {
  return (bundle.cookies || []).map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    expires: typeof c.expires === 'number' && c.expires > 0 ? Math.floor(c.expires) : -1,
    httpOnly: Boolean(c.httpOnly),
    secure: Boolean(c.secure),
    sameSite: ['Strict', 'Lax', 'None'].includes(c.sameSite) ? c.sameSite : 'Lax',
  }));
}

/** Context options that mirror the human's fingerprint-adjacent env (spec §6 `env`). */
export function bundleContextOptions(bundle) {
  const env = bundle.env || {};
  const opts = {};
  if (env.userAgent) opts.userAgent = env.userAgent;
  if (env.acceptLanguage) opts.locale = env.acceptLanguage.split(',')[0];
  if (env.timezone) opts.timezoneId = env.timezone;
  if (env.viewport?.w) opts.viewport = { width: env.viewport.w, height: env.viewport.h };
  return opts;
}

/** Apply cookies + localStorage to an existing context. Call before opening pages. */
export async function importIntoContext(context, bundle) {
  const cookies = bundleCookies(bundle);
  if (cookies.length) await context.addCookies(cookies);
  const storage = (bundle.origins_storage || []).filter((o) => (o.localStorage || []).length);
  if (storage.length) {
    // addInitScript runs before any page script on every navigation, so the
    // token is present on first paint — important for SPAs that read it at boot.
    await context.addInitScript((entries) => {
      const mine = entries.find((e) => e.origin === location.origin);
      if (!mine) return;
      for (const { name, value } of mine.localStorage) {
        try { localStorage.setItem(name, value); } catch { /* quota or disabled */ }
      }
    }, storage);
  }
  return context;
}

/** New context with the bundle's env mirrored and its cookies/localStorage applied. */
export async function newContextFromBundle(browser, bundle, extraOptions = {}) {
  const ctx = await browser.newContext({ ...bundleContextOptions(bundle), ...extraOptions });
  await importIntoContext(ctx, bundle);
  return ctx;
}

export function loadBundle(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

// ---------------------------------------------------------------- self-test CLI

if (import.meta.url === `file://${process.argv[1]}`) {
  const [bundlePath, url] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const headed = process.argv.includes('--headed');
  if (!bundlePath || !url) {
    console.error('usage: node import-bundle.mjs <bundle.json> <url> [--headed]');
    process.exit(1);
  }
  const { chromium } = await import('playwright');
  const bundle = loadBundle(bundlePath);
  const browser = await chromium.launch({ headless: !headed });
  try {
    const ctx = await newContextFromBundle(browser, bundle);
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    console.log(JSON.stringify({ url: page.url(), title: await page.title(), cookies: bundle.cookies?.length || 0 }));
  } finally {
    await browser.close();
  }
}
