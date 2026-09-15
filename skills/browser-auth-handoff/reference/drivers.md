# Importing a bundle per browser driver

The bundle (spec §6) has three parts you apply: `cookies`, `origins_storage[].localStorage`,
and `env`. The pattern is always: set cookies, seed localStorage on the target origin
*before* the app's scripts read it, mirror the env, then load the walled page and verify.

Fields: `expires` is UNIX seconds or `-1` (session cookie). `sameSite` is `Strict|Lax|None`.
`httpOnly` and `secure` are booleans.

## Playwright (reference implementation)

Use `scripts/import-bundle.mjs`. It maps cookies, seeds localStorage via
`context.addInitScript` (runs before first paint, so SPAs see the token at boot), and sets
`userAgent`/`locale`/`timezoneId`/`viewport` from `env`.

```js
import { chromium } from 'playwright';
import { newContextFromBundle, loadBundle } from '../scripts/import-bundle.mjs';
const browser = await chromium.launch();
const context = await newContextFromBundle(browser, loadBundle('./session.json'));
const page = await context.newPage();
await page.goto(hintUrl);
```

## Puppeteer

```js
const bundle = JSON.parse(fs.readFileSync('session.json', 'utf8'));
const page = await browser.newPage();
if (bundle.env?.userAgent) await page.setUserAgent(bundle.env.userAgent);
await page.setCookie(...bundle.cookies.map(c => ({
  name: c.name, value: c.value, domain: c.domain.replace(/^\./, ''), path: c.path,
  expires: c.expires > 0 ? c.expires : -1, httpOnly: !!c.httpOnly, secure: !!c.secure,
  sameSite: c.sameSite,
})));
for (const o of bundle.origins_storage || []) {
  await page.evaluateOnNewDocument((entry) => {
    if (location.origin !== entry.origin) return;
    for (const { name, value } of entry.localStorage) localStorage.setItem(name, value);
  }, o);
}
await page.goto(hintUrl);
```

## chrome-devtools MCP (raw CDP)

Cookies go in with `Network.setCookies` (or `Storage.setCookies`). localStorage has no direct
CDP setter, so navigate to the origin first, then set it with an evaluate and reload:

1. `Network.setCookies({ cookies: [...] })` — map each bundle cookie; use `expires` (omit or
   `-1` for session), `httpOnly`, `secure`, `sameSite`.
2. Navigate to the origin root (`https://app.example.com/`).
3. `Runtime.evaluate` with:
   `for (const {name,value} of ITEMS) localStorage.setItem(name, value)` (inline the origin's
   `localStorage` array).
4. Navigate to the hint URL and verify.

## claude-in-chrome MCP

This drives the human's own Chrome, where they are usually already logged in — so a handoff
is rarely needed there. If you do need to inject a bundle into a *separate* automated Chrome,
use `mcp__claude-in-chrome__javascript_tool` to set localStorage after navigating to the
origin, and set cookies through that Chrome's CDP/cookies API. Prefer just asking the human
to log in in the tab you are already driving.

## Tier 2: routing through the relay proxy

When the request came back `"proxied": true`, create the context so **all** its traffic goes
through the returned `proxy` (`{server, username, password}`, server is a full URL).

- **Playwright:** `newContextFromBundle(browser, bundle, { proxy: res.proxy })`, or
  `browser.newContext({ proxy: res.proxy, ...bundleContextOptions(bundle) })`.
- **Puppeteer:** launch with `args: ['--proxy-server=' + res.proxy.server]` and answer auth via
  `page.authenticate({ username: res.proxy.username, password: res.proxy.password })`.
- **chrome-devtools MCP / CDP:** set the proxy at launch (`--proxy-server`) and handle
  `Fetch.authRequired` / the auth challenge with the username and password.

Use the proxy for the whole context, not just the first navigation — an IP-bound site checks
every request, not only the login.

## Verifying you are past the wall

- No login/OTP field present; not redirected to a login/SSO/authwall URL.
- The content the task needs is visible, or the API call that returned 401/403 now returns 2xx.
- For token-in-localStorage apps, confirm the SPA rendered the authed view (the token must be
  present *before* first paint — that is why localStorage is seeded via an init script, not
  after load).
