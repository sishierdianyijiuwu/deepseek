# @deepseek-ai/dsh-account-postgres

English | [中文](README.zh.md)

PostgreSQL Service Provider for `ctx.accounts`. Config `url` is a `postgres://` / `postgresql://` connection string, or `pglite:` for an in-process PostgreSQL engine used by tests. `publicBaseUrl` is the origin used in verification and password-reset links. Missing `url` or `publicBaseUrl`, a failed connection, or a schema version other than `SCHEMA_VERSION` (2) fails at load. Email uniqueness is enforced by a unique index; concurrent duplicate registration yields one Account.

Passwords are stored as scrypt hashes. Verification tokens, password-reset tokens, and Sign-in session ids are stored as SHA-256 of the raw secret. A live Sign-in session slides forward by `signInTtlMs` (default 14 days) on `lookupSignIn`. Password-reset tokens last `passwordResetTtlMs` (default 1 hour); `account_id` is unique so an Account has at most one live token. `resetPassword` consumes that token with `DELETE … RETURNING`, then replaces the Password hash and deletes every Sign-in session row. The provider injects `ctx.mailer` and sends the verification message after a successful insert. If that send throws, `register` returns `mail_failed`; `resendVerification` and `requestPasswordReset` stay a silent success so the HTTP route cannot enumerate Accounts.

## Model Experience

None, as PostgreSQL Account rows never enter a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No Ban or Deletion columns** — later tickets add those control-plane records.
