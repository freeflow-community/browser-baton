# Session Handoff — MVP

A remote coding agent drives its own browser. When it hits a login wall, a human
completes the login in their own Chrome and the agent receives a usable session
for the affected origins. Implements §13 of `session-handoff-spec.md`.

```
 agent (any browser driver)   relay (this repo)          human's Chrome
 ──────────────────────────   ─────────────────          ──────────────
 handoff request ───────────▶ queue ──────WS───────────▶ request window
                                                          human logs in, clicks Done
 bundle.json ◀── handoff request ◀──HTTPS── queue ◀─HTTP─ session_bundle (sealed box)
 import cookies + localStorage, reload, handoff report ──▶ ✓ / ✗ shown in extension
```

Payloads are end-to-end encrypted (X25519 sealed boxes via tweetnacl); the relay
stores opaque envelopes only. Every envelope is Ed25519-signed by its sender and verified by the recipient (spec §5).

## Layout

| Path | What |
|---|---|
| `relay/` | Single-process relay: pairing registry, per-pairing queues, WebSocket for the extension, long-poll for the CLI, plus a per-pairing CONNECT/forward **proxy** for tier 2. In-memory with a JSON snapshot (`relay/data/state.json`). |
| `extension/` | Chrome MV3 extension. One pairing. A request auto-opens a compact window (Start / Done / Decline); after Start, a floating panel is injected onto the login tab so Done is right there, surviving the login redirects. Exports cookies (`chrome.cookies`) and localStorage (content script) for the requested origins. For tier 2, applies a scoped PAC so the login egresses through the relay proxy. |
| `cli/` | `handoff pair | request | report | proxy | status | revoke`. Config in `$HANDOFF_HOME` or `~/.handoff/`. |
| `skills/browser-auth-handoff/` | **How an agent uses this.** Agent-facing skill: recognize an auth wall (agent's own judgment), request a session with the `handoff` CLI, import the bundle, verify, report. Bundles a reusable Playwright importer (`scripts/import-bundle.mjs`) and per-driver recipes for Puppeteer / chrome-devtools MCP / CDP (`reference/drivers.md`). |
| `testsite/` | Local toy site with a cookie-auth app and a localStorage-token app. |
| `test/e2e.mjs` | Automated run of the four MVP success criteria with the real extension loaded in Chromium. |
| `test/agent-sim.mjs` | The scripted "agent" the e2e suite drives (request → import → verify → report), so the suite exercises the full stack without a real LLM. Not a component anyone runs by hand — a real agent follows the skill instead. |

## Quick start

Requires Node 20+ and Chrome 116+.

```sh
npm install
npx playwright install chromium     # for the e2e test

# 1. relay
npm run relay                       # http://127.0.0.1:8787

# 2. extension: chrome://extensions → Developer mode → Load unpacked → ./extension

# 3. pair
node cli/bin/handoff.js pair --name my-agent
#   prints a code like  ABCD-EFGH ; enter it in the extension popup (relay URL http://127.0.0.1:8787)
```

Now an agent can request a session whenever it hits an auth wall. By hand, against the
local test site (user `alice` / password `wonderland`):

```sh
npm run testsite                    # http://127.0.0.1:4321

# ask for a session; a request window pops in Chrome — click Start, log in, click Done
node cli/bin/handoff.js request \
  --origins http://127.0.0.1:4321 \
  --hint http://127.0.0.1:4321/cookie/app \
  --label "Read the cookie app" \
  --out ./session.json

# then import ./session.json into your browser context and continue (see the skill)
node skills/browser-auth-handoff/scripts/import-bundle.mjs ./session.json http://127.0.0.1:4321/cookie/app
node cli/bin/handoff.js report --ok
```

Set `HANDOFF_RELAY` (or `--relay`) to point `handoff pair` at a hosted relay; the relay
URL is stored with the pairing afterwards.

## Using it from an agent

`skills/browser-auth-handoff/` is a Claude Code skill: it tells any agent driving a browser
how to recognize an auth wall (its own judgment, no detector), request a session with the
`handoff` CLI, import the bundle with `scripts/import-bundle.mjs` (Playwright) or the
`reference/drivers.md` recipes (Puppeteer, chrome-devtools MCP, CDP), verify, and report. To
make it available to Claude Code, copy or symlink it into a skills directory:

```sh
ln -s "$PWD/skills/browser-auth-handoff" ~/.claude/skills/browser-auth-handoff
```

## CLI

```
handoff pair    [--name NAME] [--relay URL]
handoff request --origins a,b [--hint URL] [--label TEXT] [--timeout 30m] [--out FILE] [--tier 1|2]
handoff report  [--request ID] (--ok | --failed "reason")
handoff proxy   --origins a,b
handoff status
handoff revoke  [PAIRING_ID]
```

`request` writes the bundle to `--out` and prints `{"request_id","proxied":false,"silent":false,"out"}`
on stdout. Exit codes: 0 bundle, 2 declined, 3 timeout, 4 unpaired. Re-running `request` with the
same origins while one is pending resumes it (same `request_id`) instead of raising a second badge.
`report` defaults to the most recent completed request.

## Bundle

Superset of Playwright `storageState` (spec §6): `cookies[]`, `origins_storage[].localStorage[]`,
plus `origins`, `env` (userAgent, acceptLanguage, timezone, viewport). `sessionStorage`,
`indexedDB`, silent renewal, and per-pairing policy are deferred per §13.

## Tier 2 (IP-bound sessions)

Some sites bind a session to the IP it was minted from, so a bundle replayed from the agent's
IP is rejected. Tier 2 routes both the human's login and the agent's later traffic through the
relay's per-pairing proxy, so both share the relay's egress IP.

- `handoff request --tier 2 …` sends a tier-2 request. On Start, the extension applies a scoped
  PAC (only the requested hosts go through the proxy) and answers the proxy's auth challenge.
- The reply's stdout JSON comes back `{"proxied": true, "proxy": {server, username, password}, …}`.
  The agent builds its browser context with that proxy (the skill's importer takes a `proxy` option).
- Tier is learned: a failed tier-1 report marks the origins as tier-2 candidates, so a later
  `request` without `--tier` escalates automatically. `handoff proxy --origins a,b` prints the
  proxy settings when those origins are known to need it, else `null`.

Egress stickiness is per pairing; in the single-process relay there is one egress IP, so a real
multi-egress deployment is still future work (§12).

## Tests

```sh
npm run test:e2e        # HEADED=1 to watch the browser
```

Starts a relay and the test site on private ports, launches Chromium with the extension,
pairs through the popup, logs the "human" in, runs the agent sim against both apps, kills a
pending `request` and re-runs it to prove it resumes, restarts Chromium to prove the pairing
survives, runs a full **tier-2** flow (PAC applied on Start, login and agent traffic both
through the relay proxy, proxy cleared on Done, tier learned), and exercises Decline.

## Notes and known limits

- The extension asks for `http://*/*` and `https://*/*` host permissions up front; the spec's
  per-origin on-demand permissions are a follow-up.
- Denylist is hardcoded: `accounts.google.com`, `login.microsoftonline.com`, `www.paypal.com`.
- Cookies are included when their domain equals a requested host or a parent domain of it; the
  relay-side queue keeps envelopes for 24h and dedupes by `msg_id`.
- If no tab for an origin is open when you click Done, the extension briefly opens one in the
  background to read localStorage, then closes it.
- Relay state survives restarts via `relay/data/state.json` (set `RELAY_STATE_FILE=` to disable).
