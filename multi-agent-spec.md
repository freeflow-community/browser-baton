# Multi-Agent / Multi-Browser — Design Spec

Version 0.1 — Draft. Addendum to `session-handoff-spec.md`; section numbers below are local to this document.

## 1. Purpose

Today one Chrome install (one extension identity) holds exactly one pairing, and a request's agent is implicit. This spec lets:

- **One Chrome install register many agents.** A human pairs several agents with the same browser; each is a distinct, named, revocable registration.
- **A request identify its agent.** When an agent asks for a session, the human sees *which* agent is asking, and that identity is cryptographically bound, not self-asserted.
- **One agent reach many browsers** (already true at the relay/CLI level) with real routing and selection ergonomics.

Non-goals: sharing one session across agents, cross-agent delegation, and any change to how a bundle is exported.

## 2. What already holds

- The **relay** is inherently multi-pairing: many pairings, each with its own agent/ext identities, per-side tokens, proxy credentials, queue, and WebSocket. No relay change is required for the core of this feature.
- The **CLI** already stores one pairing file per pairing and can target one with `--pairing`. It just lacks names and selection UX.
- The **extension** is the constraint: it stores a single `pairing` and opens a single WebSocket. This is what changes.

## 3. Identity model

Unchanged primitives (spec §3.1): each agent and each extension profile holds a long-lived X25519 (encryption) and Ed25519 (signing) keypair. A **pairing** binds one agent identity to one extension identity and is the unit of registration.

New rule: **an extension profile may hold N pairings, each to a different agent.** The extension keeps its single identity across all of them; every agent pairs against that same extension public key.

**Agent identity is the pairing, never a payload claim.** A `needs_session` is attributed to an agent by the pairing it arrived on: the message rode that pairing's token and is Ed25519-signed by that agent's key (verified against `pairing.agent_sign_pk`). The extension therefore *derives* the requesting agent from the verified pairing and displays it. A self-asserted agent id in the payload would be spoofable and is explicitly not trusted. An agent that wants to add per-request context (a task or run label) uses the existing display-only `task_label`, plus an optional `agent_context` string (§7), both shown but never used for identity or authorization.

## 4. Extension changes

### 4.1 Storage: a pairings map

Replace the singular `pairing` with:

```
pairings: { [pairing_id]: PairingRecord }
```

```
PairingRecord {
  pairing_id, relay_http, relay_ws, token,
  agent: { agent_id, display_name, agent_sign_pk, agent_enc_pk },
  agent_fingerprint,
  label,                 // human-editable friendly name, defaults to agent.display_name
  proxy,                 // per-pairing tier-2 credentials
  policy,                // §6, optional
  created_at, revoked
}
```

`requests` becomes keyed by `request_id` as today, but each request record carries its `pairing_id` so the UI can attribute and group it. Migration: on upgrade, an existing single `pairing` moves into `pairings` under its id; nothing else changes.

### 4.2 Transport: one connection per pairing (v1)

The extension maintains one WebSocket per pairing, keyed by `pairing_id`, each authenticating that pairing's token, each with its own reconnect/backoff. Pairings may live on different relays, so per-pairing connections fall out naturally. The relay is unchanged: one authenticated socket still maps to one pairing.

This is O(agents) sockets. For a handful of agents that is fine; §9 proposes an optional multiplexed transport for scale.

### 4.3 Request handling

- Inbound `needs_session` on a pairing's socket is verified (signature) and attributed to that pairing's agent.
- Denylist and per-agent policy (§6) are evaluated with the agent in scope.
- Concurrent requests from different agents are independent request cards, each labeled with its agent's name and fingerprint. The badge counts all pending across agents.
- The auto-opened window lists all pending requests, grouped by agent. The in-page panel header names the requesting agent.
- Idempotency (spec §5.2) is scoped per pairing: an identical unanswered request from the *same* agent replaces the old one; the same origins from a *different* agent is a separate request.

### 4.4 UI: an Agents section

The popup gains an **Agents** list: each registered agent shows name, fingerprint, relay, and online status, with **Rename**, **Revoke**, and an **Add agent** action (enter a pairing code, as today). Registering shows the new agent's fingerprint for the human to confirm (trust on first use). Re-pairing an existing `agent_id` **replaces** that agent's pairing (re-key) rather than adding a duplicate.

## 5. CLI changes (the reverse direction: one agent, many browsers)

The CLI already holds many pairings. Add:

- **Names.** `handoff pair --name` already sets the *agent* display name shown to the human; add a local `label` for the *browser/pairing* so the operator can tell their own pairings apart. `handoff agents` (alias of an expanded `handoff status`) lists pairings with labels, fingerprints, relay, and online state.
- **Selection.** `--pairing <id|label>` targets one pairing (prefix match). `handoff use <id|label>` sets the default so plain `request` targets it, replacing today's implicit "newest wins."
- **Fan-out across one agent's browsers** (optional, §8): `--broadcast` sends the request to every browser paired to this agent; the first `session_bundle` wins and the losers are cancelled.

## 6. Per-agent policy (optional, phase 2)

Each `PairingRecord.policy` may carry: `allowed_origins` (glob list), `allow_tier2`, `allow_silent`, and extra denylist entries. A request that violates its agent's policy is auto-declined with reason `policy`, before any prompt. Absent a policy, behavior is today's (prompt for everything not denylisted). This bounds what any single registered agent can ask for.

## 7. Envelope / message additions

- `needs_session` payload gains an optional **`agent_context`** string: display-only free text (task id, run url) surfaced in the UI. Never used for identity or authz.
- New message **`cancel`** (agent → ext): `{ request_id | broadcast_id, reason }`. Withdraws a pending request; the extension removes its card/panel and clears any tier-2 proxy it applied. Used by broadcast losers (§8) and by an operator aborting a `request`.
- No field carries an agent identity; identity is the pairing plus signature (§3).

The envelope shape, encryption, and signing are unchanged from the base spec — this feature rides them.

## 8. Fan-out routing (optional, phase 3)

For one agent paired to several browsers, `handoff request --broadcast`:

1. The CLI assigns a shared `broadcast_id` and sends the same `needs_session` to each of the agent's pairings.
2. It waits on all of them. The **first** `session_bundle` wins; its bundle is written and reported.
3. The CLI sends `cancel { broadcast_id }` to the other pairings, so their extensions drop the prompt.

This gives "ask whichever browser is available, first to respond wins" without any relay change (the CLI simply talks to N pairings). A relay-side fan-out is possible later but not required.

## 9. Optional: multiplexed transport (scale)

To avoid one socket per agent on a shared relay, a v2 `/v1/ext` may accept **multiple** auth frames on one socket, associating it with several pairings; the relay tags each pushed `message` with its `pairing_id` (already present in the envelope) and accepts `ack`/`send` for any of them. The extension then holds one socket per *relay* rather than per *pairing*. This is a pure optimization, gated behind a protocol version bump, and out of scope for the first implementation.

## 10. Security

- **No impersonation.** An agent can only transmit on its own pairing (token) and its messages are signed by its own key; the extension shows identity derived from the verified pairing, so agent A cannot appear as agent B.
- **Isolation.** Pairings are independent. Revoking one agent rotates only that pairing's tokens and proxy credentials and drops only its queued messages; other agents are unaffected.
- **Least privilege.** Per-agent policy (§6) and the denylist bound each agent's blast radius. The human confirms each agent's fingerprint at registration.
- **Tier-2 concurrency caveat.** The relay proxy is one address with per-pairing Basic auth, and the extension's PAC routes a host to that one address; the browser's `onAuthRequired` cannot tell which agent a proxied connection belongs to. So **only one tier-2 login may be active at a time** per extension. A second tier-2 `Start` while one is active is queued (or declined with reason `busy`) until the first completes. Tier-1 requests have no such limit and run concurrently.

## 11. Migration & compatibility

- Extension storage migrates `pairing` → `pairings` (single entry); single-agent installs behave exactly as before.
- Relay needs no change for phases 1–3; only the optional §9 multiplex touches it.
- CLI pairing files are already multi; the additions are labels and selection.
- Older extensions (single pairing) and newer CLIs interoperate: a second `handoff pair` against an old extension still just replaces its one pairing.

## 12. Phasing

- **Phase 1 — core.** Extension holds N pairings; one WS per pairing; requests attributed to a verified agent and labeled in badge/window/panel; Agents section with add/rename/revoke; storage migration. CLI: labels, `handoff agents`, `--pairing <id|label>`, `handoff use`.
- **Phase 2 — policy & control.** Per-agent policy with `policy` decline reason; the `cancel` message; tier-2 single-active-login handling.
- **Phase 3 — fan-out.** `--broadcast` with `broadcast_id` and loser `cancel`.
- **Later.** Multiplexed transport (§9); relay-side fan-out.

## 13. Open questions

- Cap on registered agents per install, and per-agent rate limits at the relay.
- Whether re-pairing an existing `agent_id` should preserve that agent's local `label` and `policy` (proposed: yes, carry them over).
- Tier-2 concurrency: is single-active-login acceptable, or do we want per-agent egress ports on the relay so several can proxy at once?
- Whether `handoff use` (default pairing) belongs in shared config or per-terminal, when one operator drives several agents from one machine.
