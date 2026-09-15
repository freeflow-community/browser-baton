# Session Handoff — Protocol Specification

Version 0.1 — Draft

## 1. Purpose

A remote coding agent drives its own browser. When it hits an authentication wall, a human completes login in their own Chrome, and the agent receives a usable session for the affected origins. The human never drives the agent's browser.

Three components implement one protocol:

| Component | Runs where | Role |
|---|---|---|
| **Extension** | Human's Chrome | Durable endpoint; exports sessions; applies scoped proxy |
| **Relay** | Hosted service | Pairing registry, encrypted message queue, CONNECT proxy |
| **CLI** | Wherever the agent runs | Stateless commands for pairing, requesting, importing |

The relay is untrusted for content: all bundles are end-to-end encrypted between extension and CLI.

## 2. Terminology

- **Origin** — scheme + host + port, e.g. `https://app.example.com`.
- **Bundle** — the exported browser state for a set of origins (§6).
- **Pairing** — a mutual key binding between one extension identity and one agent identity.
- **Request** — a single `needs_session` exchange, identified by `request_id`.
- **Tier 1** — human logs in from their own IP; no proxy.
- **Tier 2** — human logs in through the relay proxy so the session is minted from the relay's egress IP; agent later uses the same proxy for those origins.

## 3. Identities and pairing

### 3.1 Keys

Each extension and each agent holds a long-lived X25519 keypair (for encryption) and an Ed25519 keypair (for signing). Identity ID = base32 of the Ed25519 public key. Keys never leave the device that generated them.

### 3.2 Pairing flow

1. CLI: `handoff pair` → `POST /v1/pairings/begin` with `{agent_id, agent_sign_pk, agent_enc_pk, display_name}`. Relay returns `{pairing_code, expires_at}` (8 chars, 10-minute TTL). CLI prints code and QR, then long-polls `GET /v1/pairings/{code}/wait`.
2. Human enters the code in the extension. Extension → `POST /v1/pairings/{code}/accept` with `{ext_id, ext_sign_pk, ext_enc_pk, sig}` where `sig` signs `code || agent_id`.
3. Relay stores the pairing `{pairing_id, agent_id, ext_id}` and issues per-side bearer tokens for the relay API and per-pairing proxy credentials.
4. Both sides display the peer's display name and key fingerprint. Human confirms in the extension. CLI stores `{pairing_id, ext_enc_pk, ext_sign_pk, token, proxy_creds}` in its config dir.

### 3.3 Revocation

Either side: `DELETE /v1/pairings/{pairing_id}`. Relay drops queued messages and invalidates proxy credentials. The extension shows the pairing as revoked; the CLI's next call fails with `unpaired`.

## 4. Transport

- **Extension → relay:** persistent WebSocket `wss://relay/v1/ext` authenticated with the extension's bearer token. Reconnect with exponential backoff (1s → 60s). The relay delivers queued messages on connect.
- **CLI → relay:** plain HTTPS. `POST /v1/pairings/{id}/messages` to send; `GET /v1/pairings/{id}/messages?wait=<seconds>` to long-poll for replies.
- **Proxy:** `https://proxy.relay:443`, HTTP CONNECT with Basic auth using per-pairing credentials. Egress IP is sticky per pairing.

All messages on both paths share one envelope (§5).

## 5. Message envelope

```json
{
  "v": 1,
  "pairing_id": "…",
  "msg_id": "uuid",
  "type": "needs_session",
  "ts": 1757800000,
  "from": "agent | ext",
  "payload": "<base64 sealed box>",
  "sig": "<base64 Ed25519 over v|pairing_id|msg_id|type|ts|from|payload>"
}
```

`payload` is the JSON body encrypted with the recipient's X25519 public key (libsodium sealed box or equivalent). The relay validates only `pairing_id`, `from`, and token; it stores the envelope opaquely with a TTL (default 24h).

### 5.1 Message types

**agent → ext**

| type | payload |
|---|---|
| `needs_session` | `{request_id, origins: [origin], tier: 1\|2, hint_url, task_label, expires_at, allow_silent: bool}` |
| `report` | `{request_id, ok: bool, reason?: string}` |
| `revoke_session` | `{origins}` — informational; human should log out |

**ext → agent**

| type | payload |
|---|---|
| `session_bundle` | `{request_id, bundle: Bundle, proxied: bool, silent: bool}` |
| `declined` | `{request_id, reason: "user" \| "denylist" \| "timeout" \| "unsupported"}` |
| `heartbeat` | `{ts}` (optional; relay may synthesize) |

### 5.2 Request lifecycle

```
agent: needs_session ──▶ ext (badge/notification, or silent path)
ext:   [tier 2: apply PAC for origins]
ext:   human logs in (or already logged in)
ext:   export bundle for origins
ext:   [tier 2: remove PAC]
ext:   session_bundle ──▶ agent
agent: import, reload, verify
agent: report ──▶ ext (shown as ✓ or ✗ + reason)
```

Timeout: if no reply by `expires_at`, the CLI exits `3`. The extension marks the request stale and hides it.

Idempotency: a `needs_session` with an `origins` set identical to an unanswered pending request from the same pairing replaces it rather than creating a second badge.

## 6. Bundle format

Superset of Playwright `storageState`, so unextended consumers can ignore the new fields.

```json
{
  "version": 1,
  "exported_at": 1757800000,
  "origins": ["https://app.example.com", "https://login.idp.com"],
  "cookies": [ { "name","value","domain","path","expires","httpOnly","secure","sameSite" } ],
  "origins_storage": [
    {
      "origin": "https://app.example.com",
      "localStorage": [ {"name","value"} ],
      "sessionStorage": [ {"name","value"} ],
      "indexedDB": [ { "db","version","stores":[{"name","keyPath","autoIncrement","records":[{"key","value"}]}] } ]
    }
  ],
  "env": { "userAgent","acceptLanguage","timezone","viewport":{"w","h"} }
}
```

Rules:
- Cookies are included if their domain matches any requested origin's host or a parent domain of it (so `.example.com` is included for `app.example.com`).
- `sessionStorage` and `indexedDB` are best-effort; omit if the origin has no open tab.
- Values are serialized with structured-clone-to-JSON; binary IndexedDB values are base64 with a `"$b64"` marker.
- `env` lets the agent mirror the human's fingerprint-adjacent settings.

## 7. Extension behavior

- **Permissions requested:** `cookies`, `storage`, `proxy`, `tabs`, `scripting`, host permissions on demand per origin.
- **Denylist:** default-on list of financial and identity-provider account-management origins (configurable). Requests touching a denylisted origin are `declined: denylist`.
- **Per-pairing policy:** allowed origins (glob), `allow_silent` override, tier-2 permission.
- **Silent path:** if `allow_silent` is true, policy permits it, and the extension can verify an existing live session (a `fetch` to `hint_url` with credentials returns non-redirect 2xx), export without prompting.
- **Interactive path:** badge + notification. Clicking opens a panel showing agent name, task label, origins, tier. "Start" opens `hint_url` in a new tab (through PAC if tier 2). "Done" triggers export. "Decline" sends `declined: user`.
- **PAC rule (tier 2):** `chrome.proxy.settings.set` with a PAC that returns `HTTPS proxy.relay:443` for the requested origins' hosts (and their parent domains) and `DIRECT` otherwise. Proxy auth answered via `webRequest.onAuthRequired`. Cleared on Done, Decline, or timeout.
- **Audit log:** per pairing, last N requests with origins, tier, outcome.

## 8. CLI behavior

Config dir: `$HANDOFF_HOME` or `~/.handoff/`, containing `identity.json`, `pairings/<id>.json`, `origins.json` (learned tier per origin).

| Command | Behavior | Exit codes |
|---|---|---|
| `handoff pair [--name NAME]` | §3.2. Prints code/QR, blocks until accepted. | 0 ok, 1 error |
| `handoff request --origins a,b [--tier 1\|2] [--hint URL] [--label TEXT] [--timeout 30m] [--silent] --out FILE` | Sends `needs_session`, long-polls, decrypts, writes bundle to `FILE`. Prints JSON `{proxied, proxy?: {server,username,password}, silent}` to stdout. If `--tier` omitted, uses learned tier for those origins, default 1. | 0 bundle, 2 declined, 3 timeout, 4 unpaired |
| `handoff report --request ID --ok \| --failed "reason"` | Sends `report`. On `--failed` after tier 1, marks origins as tier-2 candidates. | 0 |
| `handoff proxy --origins a,b` | Prints proxy settings if any listed origin is learned tier 2; else prints `null`. | 0 |
| `handoff status` | Lists pairings, pending requests, learned origins. | 0 |
| `handoff revoke [PAIRING_ID]` | §3.3. | 0 |

The CLI holds no long-lived connection. Re-running `request` with the same origins while one is pending resumes waiting on the existing request.

## 9. Agent integration

```
proxy = handoff proxy --origins <origins>            # null or settings
ctx   = browser.newContext(proxy=proxy)              # main context, usually direct
... navigate; detect wall ...
res   = handoff request --origins <origins> --hint <url> --out s.json
if exit == 0:
    if res.proxied: ctx = browser.newContext(proxy=res.proxy)
    import s.json into ctx (cookies, storage init script, IndexedDB init script)
    reload hint URL; verify
    handoff report --ok | --failed "<reason>"
    if failed and tier was 1: retry with --tier 2
```

Wall detection is the agent's responsibility (password/OTP fields, IdP redirect, 401/403, model judgment). The CLI does not detect.

## 10. Relay responsibilities

- Pairing registry and token issuance.
- Per-pairing message queue, TTL 24h, opaque envelopes, at-least-once delivery with `msg_id` dedupe.
- WebSocket fan-out to the extension; HTTP long-poll for the CLI.
- CONNECT proxy: authenticates per-pairing credentials, pins the pairing to one egress IP, rate-limits, logs metadata only (no request bodies; CONNECT is opaque anyway).
- Abuse controls: pairing-code brute-force limits, per-pairing message and bandwidth quotas.

## 11. Security notes

- Relay never sees plaintext bundles or proxy-tunneled content.
- Bundles are written to disk on the agent side only at the path the agent specifies; the CLI does not cache them.
- `expires_at` on requests bounds how long a human-side prompt can linger.
- `revoke_session` gives the human a path to log out after a task; the agent should send it on task completion when policy demands.
- Proxy credentials are per-pairing and rotated on revoke; consider short-lived credentials issued per request in a later version.

## 12. Open items

- IndexedDB export scope limits (size caps, store allowlist).
- Whether agent-side token refreshes should flow back to the extension (`session_update` message) to keep the human's browser in sync.
- Multi-egress relays: sticky assignment strategy and migration.
- Firefox/Safari extension parity.

---

## 13. MVP

Goal: prove that a session minted in the human's Chrome can be handed to an agent's Playwright browser through a relay, end to end, on at least one real site. Everything not needed for that is cut.

**In scope**

- *Relay:* single process. In-memory pairing table and per-pairing message queue. Two HTTP endpoints for the CLI (`POST messages`, `GET messages?wait`), one WebSocket for the extension. Bearer tokens. No proxy.
- *Extension:* pair by pasting a code. One pairing only. Badge on `needs_session`; panel with Start / Done / Decline. Export cookies (via `chrome.cookies`) and localStorage (via a content script) for the requested origins. No sessionStorage, no IndexedDB, no PAC, no silent path, no denylist beyond a hardcoded two or three.
- *CLI:* `pair`, `request --origins --hint --out`, `report`. Config in `~/.handoff/`. Exit codes as spec'd.
- *Crypto:* keep the envelope shape but use libsodium sealed boxes with no signing, or ship v0 with TLS only and a `crypto: none` flag, to be replaced before anyone outside the team uses it.
- *Agent harness:* a 30-line Playwright script that opens a target site, checks for a password field, shells out to `handoff request`, imports the bundle with `addCookies` + an `addInitScript` for localStorage, reloads, and prints whether it landed past the login.

**Success criteria**

1. Pair once; the extension stays connected across a Chrome restart.
2. Run the harness against a site with cookie-based auth (e.g. a GitHub or Notion-style app). Log in when the badge appears. Harness reports `ok` and can load an authenticated page.
3. Repeat against a site that keeps its token in localStorage. Same result.
4. Kill the agent mid-request, re-run `request`; the pending request resumes rather than duplicating.

**Explicitly deferred**

Tier 2 / proxy, IndexedDB, silent renewal, per-pairing policy, multi-pairing, audit log, learned origin tiers, `revoke_session`, full signature scheme. Tier 2 is the first follow-on: add the CONNECT proxy to the relay, PAC handling to the extension, and `--tier 2` plus proxy output to the CLI, then test against a site known to bind sessions to IP.
