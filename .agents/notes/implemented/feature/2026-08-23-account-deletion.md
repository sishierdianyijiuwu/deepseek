# Agent Note: Account Deletion

Status: implemented

English | [中文](2026-08-23-account-deletion.zh.md)

## Problem

A person leaving the hosted product needed a way to erase their Account without an Operator, while a security Ban must keep Sessions, Workspaces, and Credentials for audit. Collapsing both into one action would either destroy evidence or force every departure through an Operator.

## Decision

Deletion is self-service of the signed-in Account. `POST /auth/delete` requires a live Sign-in session, erases that Account's cloud Workspaces (`deleteAllOwned`), Credential document (`eraseOwned`), and persisted Session logs (`deleteOwned`) — running every composed follow-up even if one throws — then `accounts.deleteAccount(accountId)` `DELETE`s the PostgreSQL Account row (verification tokens, password-reset tokens, and Sign-in sessions CASCADE). `{ ok: true }` only after those artifacts are gone. The cookie is cleared once the Sign-in session is accepted, including when erase throws, so a leftover browser cookie cannot look live after a failed attempt. Ban remains a separate non-erasing Operator action: `banned_at` stays, `register` returns `email_taken`, and Operator access can still read that Account. Hosted sets `requireOwnedErase: true` so a missing follow-up service fails the request rather than reporting success with leftover files.

After Deletion the same email can register as a new Account with a new id. Other Accounts' rows, files, and logs are not selected. Operator Deletion of their own Account uses the same route and the same owner filter.

A Banned Account cannot perform Deletion: `lookupSignIn` returns `undefined`, so the route is `forbidden`.

## Alternatives considered

**Operator-only Deletion.** Rejected because a person leaving must not need an Operator, and an Operator deleting someone else is a different authorization than self-service.

**Soft-delete `deleted_at` column.** Rejected because the email must be free to register again, and Ban already keeps the row when evidence must remain. `SCHEMA_VERSION` stays 4; Deletion is a `DELETE`, not a new column.

**One action that both Bans and erases.** Rejected: a security Ban must not destroy evidence, and Deletion must not require an Operator.

**Cascade inside `PostgresAccounts`.** Rejected because Sessions, Workspaces, and Credentials belong to other seams. The HTTP Consumer orchestrates `ctx.get` peers. Auth-only tests omit `requireOwnedErase`; hosted sets it so a missing follow-up fails the request.

**Delete the Account row before artifact erase.** Rejected because Sign-in sessions CASCADE with the row, so a later erase throw frees the email and leaves files with no retry (`lookupSignIn` is `undefined`). Erase first, collect follow-up errors, then `DELETE` the row.

## Consequences

Live in-memory Sessions of a deleted Account are hidden from HTTP by owner mismatch; an Executing Session is not locked here. `operator_audit_log` has no foreign key, so openings remain after Deletion.

## Testing

`deletion.http.spec.ts` contrasts Deletion vs Ban for Workspace files, Session lists, and JSONL logs, including a Banned-cookie `forbidden` case and a throwing `deleteAllOwned` that leaves the Account row and Workspace files so a retry can finish (Session logs still erase). `account-credentials.http.spec.ts` contrasts Ban vs Deletion for the Credential document. Auth-only HTTP covers row Deletion, `requireOwnedErase` refusal, and re-registration. Package tests cover `deleteAccount`, `deleteAllOwned`, `eraseOwned`, and JSONL/SQLite `deleteOwned`.
