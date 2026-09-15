---
name: browser-auth-handoff
description: When you are driving a browser and get blocked by a login or authentication wall you cannot pass on your own — a password or OTP form, an SSO/OAuth redirect, a "verify it's you" checkpoint, or a 401/403 on a page that needs a signed-in session — get a real logged-in session from the paired human's own Chrome through the Session Handoff relay, import it into your browser context, and continue. The human logs in in their browser; you never see their password. Use whenever automated browsing stalls at authentication and you have a Session Handoff pairing available.
---

# Getting through auth walls with Session Handoff

You drive a browser (Playwright, Puppeteer, the `chrome-devtools` MCP, `claude-in-chrome`,
or anything else). When you hit a wall you cannot pass — because it needs a human to type a
password, approve an SSO prompt, or clear an identity check — you ask a **paired human** to
complete the login in *their own* Chrome. Their extension exports the resulting session
(cookies + localStorage) for the origins you name and sends it to you, end-to-end encrypted,
through a relay. You import it, reload, and keep going.

You never touch the human's browser and never see their password. They never touch yours.

**Deciding you are walled is your job, not a selector's.** There is no auto-detector. Treat
any of these as a wall when they block the task: a visible password/OTP field, a redirect to
a login or SSO/IdP page, an "authwall"/"sign in to continue"/"verify it's you" interstitial,
or a `401`/`403` (or a logged-out API/JSON response) on something that needs a session. When
in doubt and the page is clearly asking a human to authenticate, request a session.

## Prerequisites — check before you start

The tool is the `handoff` CLI (from the browser-baton project) plus a running relay and a
one-time pairing with the human's Chrome extension.

1. Find the CLI. If `handoff` is on `PATH`, use it. Otherwise invoke
   `node <browser-baton>/cli/bin/handoff.js`. Set `HANDOFF="handoff"` or
   `HANDOFF="node /path/to/cli/bin/handoff.js"` and use `$HANDOFF` below.
2. Run `$HANDOFF status`. You want a line showing a pairing that is **extension online**.
   - No pairing, or "not paired" → tell the human: run `handoff pair` where you (the agent)
     run, then enter the printed code in their Chrome extension. Do not proceed until paired.
   - Pairing exists but extension offline → ask the human to open Chrome (the service worker
     reconnects) and confirm the relay is running.

Do not try to start the relay, pair, or drive the human's Chrome yourself. Pairing is a
deliberate human action.

## The loop

1. **Identify the origins that need auth.** Always the site's own origin
   (`scheme://host[:port]`, e.g. `https://app.example.com`). Add any separate identity
   provider the login bounces through if the session depends on it (e.g. an SSO domain).
   Keep the set as small as the task needs.

2. **Request the session.** This blocks until the human acts (or it times out). It raises a
   badge in their Chrome; they log in if needed and click Done.

   ```sh
   $HANDOFF request \
     --origins https://app.example.com \
     --hint https://app.example.com/the/page/that/walled \
     --label "What you are trying to do (shown to the human)" \
     --timeout 15m \
     --out ./session.json
   ```

   `--hint` is the URL the human's "Start" button opens, so make it the page that needs
   auth. Exit codes decide your next move:

   | exit | meaning | do |
   |---|---|---|
   | 0 | bundle written to `--out`; a JSON line with `{request_id, proxied, silent, out}` is printed on stdout | import it (step 3) |
   | 2 | human declined | stop; tell the human it was declined and why you needed it |
   | 3 | timed out | the request stays pending; re-run the identical command to resume waiting, or stop |
   | 4 | not paired | see Prerequisites |

   Re-running `request` with the **same** `--origins` while one is pending resumes the same
   request instead of raising a second badge — safe to retry after a crash.

   If the JSON line has `"proxied": true`, it also carries a `proxy` object
   (`{server, username, password}`) — the session was minted through the relay's proxy and
   you **must** create your browser context with that proxy (step 3). See Tier 2 below.

3. **Import the bundle into your browser context** (formats and per-driver recipes below).
   Cookies and localStorage both matter: some sites keep the session in an HttpOnly cookie,
   others in a localStorage token, many in both. Import cookies *and* localStorage *and*
   mirror the `env` (user agent, timezone, locale, viewport). If the request was proxied,
   build the context with the returned `proxy` first.

4. **Reload the walled page and verify** you are past it — the content you expected is
   present, no login form, API calls return `2xx`. This is your judgment again.

5. **Report the outcome** so the human's extension shows ✓ or ✗:

   ```sh
   $HANDOFF report --request <request_id> --ok
   $HANDOFF report --request <request_id> --failed "still on the login page after import"
   ```

   `--request` defaults to the most recent request, so `$HANDOFF report --ok` usually works.

6. **If it failed**, the likely cause is that the site binds the session to the IP it was
   minted from — the human's IP differs from yours. That is what Tier 2 fixes.

## Tier 2 — IP-bound sessions

Some sites tie a session to the IP address it was created from, so a bundle minted on the
human's home IP is rejected when you replay it from yours. Tier 2 routes both the human's
login and your later traffic through the relay's proxy, so the session is minted from — and
used from — the same egress IP.

- **Ask for tier 2** with `--tier 2`:

  ```sh
  $HANDOFF request --tier 2 --origins https://app.example.com --hint … --out ./session.json
  ```

  When the human clicks Start, their browser routes just those origins through the relay proxy
  while they log in. The reply's JSON line comes back `"proxied": true` with a `proxy` object.

- **Use the same proxy** for your context. With the Playwright helper:

  ```js
  const res = JSON.parse(lastStdoutLine);            // { proxied, proxy, out, request_id }
  const ctx = await newContextFromBundle(browser, loadBundle(res.out),
    res.proxied ? { proxy: res.proxy } : {});
  ```

  For other drivers, pass the proxy the usual way (`--proxy-server=http://host:port` plus the
  username/password on the auth challenge). See `reference/drivers.md`.

- **Don't guess the tier.** Start at tier 1. If a tier-1 session fails verification, report it
  with `--failed`; that marks the origins as tier-2 candidates, and a later `request` without
  `--tier` (or `$HANDOFF proxy --origins …`) will pick tier 2 automatically. `$HANDOFF proxy
  --origins a,b` prints the proxy settings if those origins are known to need it, else `null`.

## Bundle format (spec §6)

```jsonc
{
  "version": 1,
  "origins": ["https://app.example.com"],
  "cookies": [ { "name","value","domain","path","expires","httpOnly","secure","sameSite" } ],
  "origins_storage": [ { "origin": "...", "localStorage": [ {"name","value"} ] } ],
  "env": { "userAgent","acceptLanguage","timezone","viewport": {"w","h"} }
}
```

`expires` is a UNIX-seconds number, or `-1` for a session cookie. The MVP does not export
`sessionStorage` or IndexedDB.

## Importing per driver

**Playwright** — use the bundled helper, which handles cookies, localStorage (via an init
script so it is set before first paint), and env:

```js
import { chromium } from 'playwright';
import { newContextFromBundle, loadBundle } from './scripts/import-bundle.mjs';

const bundle  = loadBundle('./session.json');
const browser = await chromium.launch();
const context = await newContextFromBundle(browser, bundle);   // env + cookies + localStorage
const page    = await context.newPage();
await page.goto('https://app.example.com/the/page/that/walled');
// verify you are past the wall
```

You can also verify a bundle straight from the shell:

```sh
node scripts/import-bundle.mjs ./session.json https://app.example.com/ [--headed]
```

**Other drivers** (Puppeteer, `chrome-devtools` MCP, `claude-in-chrome`, raw CDP): the
principle is the same — set the cookies, seed localStorage on the target origin before the
app's own scripts run, then reload. See `reference/drivers.md` for a recipe for each.

## Safety

- **A bundle is a live credential.** It grants whatever the human's session grants. Write it
  only where you were told (`--out`), use it for the task at hand, and delete it when done.
  Never print cookie values, commit a bundle, or send one to any third party.
- The extension **refuses** a hardcoded denylist of sensitive origins (identity-provider
  account management). If a request comes back declined with reason `denylist`, that origin
  is off-limits by policy — do not try to work around it.
- Request the **narrowest** origin set that unblocks you. Do not add origins "just in case."
- When the task is done and policy calls for it, ask the human to log that session out.
