# Agent Note: Operator read-only access and audit log

Status: implemented

English | [中文](2026-08-23-operator-readonly-audit.zh.md)

## Problem

Operators may open another Account's Sessions and Workspace files for support or audit, including after Ban. Ordinary Account isolation must still hold. Impersonation would let an Operator prompt and run tools inside that Account's execution world. Without a durable audit row, those openings cannot be reconstructed.

## Decision

Operator lookup is GET `/auth/operator/account?email=`. It returns existence, verified, and Banned, with no Session bodies. GET `/auth/operator/audit` lists openings, newest first. Both require `SignInLookup.operator`; ordinary Accounts and unauthenticated callers receive `{ ok: false, error: { code: 'forbidden' } }`.

Opening uses Host `/api` and the event WebSockets with header `x-dsh-operator-access` set to the target email. `dsh-client-connection` resolves that email, binds `runWithOperatorAccess`, and leaves `currentAccountId` as the Operator. The downlink recaptures `currentOperatorAccess()` so mux/host still view the target after `handleUpgrade`. `viewingAccountId` is the target, so session list/history/search/export, mux/host frames, workspace list, `workspace.listFiles`, and `workspace.read` see that Account. A non-Operator presenting the header is HTTP 403. An unknown target email is ignored (the Operator sees their own Account). Ban does not hide the target from Operator access.

Prompt, session/workspace mutations, `goal.*`, `agentPreset.select`, and `credentials.describe` / `set` / `unset` under Operator access return `operator-access-readonly`. `respond` is `not-pending`. Mux sockets remain downlink-only: a client message closes the socket with 1008. `session.models` reads the log without attaching an Agent. Credential resolution still uses the Operator Account id, so the target's secret is never the bound store. `workspace.read` `lstat`s the resolved path and refuses a symlink.

Each opening awaits `operator_audit_log` (schema version 4) before returning or yielding frames: Operator Account id and email, target Account id, optional Session id, and `opened_at`. Account-level reads (list, mux, host events, Workspace files, subagent catalog) omit `session_id`; Session log reads (history, attachment, export, subagent history) include it. A failed insert refuses the opening.

## Alternatives considered

**Impersonate by setting `currentAccountId` to the target.** Rejected by ADR 0005: Credential resolve and session.create would then run as that Account.

**Dedicated `/auth/operator/session-log` dumps instead of `/api`.** Rejected: mux and `session.history` are the product Session log; a second dump would drift. Lookup and audit stay on `/auth` because they do not open a Session body.

**Audit only an explicit open RPC.** Rejected: every successful read of another Account's Sessions or files is an opening that must be reconstructible.

**Skip the audit row when the Operator looks up by email.** Kept: lookup is existence without conversation bodies, so it is not an opening.

## Testing

Loader-composed HTTP with PGlite, two ordinary cookie jars, and an Operator jar pins: lookup by email without bodies; ordinary and unauthenticated lookup is `forbidden`; Operator `session.list` / `history` / `workspace.listFiles` / `workspace.read` with the header see the target; ordinary jars cannot list or open that Session; prompt, workspace write, Credential describe/set, `goal.create`, and `agentPreset.select` are `operator-access-readonly`; mux with the header emits a target Session frame the ordinary jar does not see, then closes 1008 on a client message; host events open for the target; subagent history of a child of that Session succeeds and is audited; audit rows name the Operator and the Account or Session; Ban still allows Operator reads. In-process ApiProxy pins the same read/refuse split through `runWithOperatorAccess`, including cold export and subagent history audit rows.

## Consequences

Operators can support or audit without impersonation. Schema version 4 has no compatibility path. An Operator who Bans their own email loses the Sign-in session and cannot open further access until the env list and a database edit recover it.
