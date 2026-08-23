# @deepseek-ai/dsh-account-postgres

English | [中文](README.zh.md)

PostgreSQL Service Provider for `ctx.accounts`. Config `url` is a `postgres://` / `postgresql://` connection string, or `pglite:` for an in-process PostgreSQL engine used by tests (`pglite:<dir>` is a directory-backed engine). `openSql` / `SqlClient` / `isUniqueViolation` are the shared control-plane SQL adapter (cloud Workspaces reuse them). `publicBaseUrl` is the origin used in verification and password-reset links. `operatorEmails` is the Operator list (normalized at load; invalid entries fail loud; empty means no Operators and the first registrant is not special). Missing `url` or `publicBaseUrl`, a failed connection, or a schema version other than `SCHEMA_VERSION` (5) fails at load. Email uniqueness is enforced by a unique index; concurrent duplicate registration yields one Account.

Passwords are stored as scrypt hashes. Verification tokens, password-reset tokens, and Sign-in session ids are stored as SHA-256 of the raw secret. A live Sign-in session slides forward by `signInTtlMs` (default 14 days) on `lookupSignIn`, which also reports `operator` and returns `undefined` when the Account is Banned. After scrypt, `signIn` `SELECT … FOR UPDATE`s the Account, re-checks `verified_at` / `banned_at`, then inserts the Sign-in session. Password-reset tokens last `passwordResetTtlMs` (default 1 hour); `account_id` is unique so an Account has at most one live token. `resetPassword` consumes that token with `DELETE … RETURNING`, then replaces the Password hash and deletes every Sign-in session row; it does not clear Ban. `banned_at` on `accounts` and singleton `registration_control.frozen_at` persist Ban and registration freeze. `ban` sets `banned_at` and deletes Sign-in sessions without deleting the Account row; `liftBan` clears Ban and deletes leftover Sign-in sessions. `executing_world_open` holds the live sandbox-running interval; `executing_world_daily` stores milliseconds per UTC day (`YYYY-MM-DD`). `beginExecutingWorld` closes a leftover open interval at the given instant before inserting; `endExecutingWorld` charges overlapped UTC days; provider start closes every leftover open interval. `deleteAccount` `DELETE`s the Account row; token, Sign-in session, and executing-world usage rows CASCADE. There is no `deleted_at` column. Frozen `register` re-reads `registration_control` under `FOR UPDATE` after scrypt and returns `registration_frozen` without inserting. `lookupByEmail` / `lookupById` return existence, verified, and Ban including Banned rows. `operator_audit_log` stores Operator-access openings (`recordOperatorAccess` / `listOperatorAccess`). The provider injects `ctx.mailer` and sends the verification message after a successful insert. If that send throws, `register` returns `mail_failed`; `resendVerification` and `requestPasswordReset` stay a silent success so the HTTP route cannot enumerate Accounts.

## Model Experience

None, as PostgreSQL Account rows never enter a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Operator audit rows are not CASCADE-deleted** — `operator_audit_log` has no foreign key to `accounts`; Deletion leaves those openings.
