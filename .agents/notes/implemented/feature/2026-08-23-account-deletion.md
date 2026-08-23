# Agent Note: Account Deletion

Status: implemented

English | [中文](2026-08-23-account-deletion.zh.md)

## Problem

A person leaving the hosted product needed a way to erase their Account without an Operator, while a security Ban must keep Sessions, Workspaces, and Credentials for audit. Collapsing both into one action would either destroy evidence or force every departure through an Operator.

## Decision

Deletion is self-service of the signed-in Account. `POST /auth/delete` requires a live Sign-in session, calls `accounts.deleteAccount(accountId)` to `DELETE` the PostgreSQL Account row (verification tokens, password-reset tokens, and Sign-in sessions CASCADE), then erases that Account's cloud Workspaces (`deleteAllOwned`), Credential document (`eraseOwned`), and persisted Session logs (`deleteOwned`). The cookie is cleared. Ban remains a separate non-erasing Operator action: `banned_at` stays, `register` returns `email_taken`, and Operator access can still read that Account.

After Deletion the same email can register as a new Account with a new id. Other Accounts' rows, files, and logs are not selected. Operator Deletion of their own Account uses the same route and the same owner filter.

A Banned Account cannot perform Deletion: `lookupSignIn` returns `undefined`, so the route is `forbidden`.

## Alternatives considered

**Operator-only Deletion.** Rejected because a person leaving must not need an Operator, and an Operator deleting someone else is a different authorization than self-service.

**Soft-delete `deleted_at` column.** Rejected because the email must be free to register again, and Ban already keeps the row when evidence must remain. `SCHEMA_VERSION` stays 4; Deletion is a `DELETE`, not a new column.

**One action that both Bans and erases.** Rejected: a security Ban must not destroy evidence, and Deletion must not require an Operator.

**Cascade inside `PostgresAccounts`.** Rejected because Sessions, Workspaces, and Credentials belong to other seams. The HTTP Consumer orchestrates optional `ctx.get` peers so an auth-only composition still deletes the Account row.

## Consequences

Live in-memory Sessions of a deleted Account are hidden from HTTP by owner mismatch; an Executing Session is not locked here. `operator_audit_log` has no foreign key, so openings remain after Deletion.

## Testing

HTTP tests contrast Deletion vs Ban: owned Workspace files, Credential documents, Session lists, and JSONL logs disappear only for the deleted Account; Ban leaves them; the email can register again; Operator self-Deletion leaves other Accounts. Package tests cover `deleteAccount`, `deleteAllOwned`, `eraseOwned`, and JSONL/SQLite `deleteOwned`.
