# @deepseek-ai/dsh-account-postgres

English | [中文](README.zh.md)

PostgreSQL Service Provider for `ctx.accounts`. Config `url` is a `postgres://` / `postgresql://` connection string, or `pglite:` for an in-process PostgreSQL engine used by tests. `publicBaseUrl` is the origin used in verification links. Missing `url` or `publicBaseUrl`, a failed connection, or a schema version other than `SCHEMA_VERSION` (1) fails at load. Email uniqueness is enforced by a unique index; concurrent duplicate registration yields one Account.

Passwords are stored as scrypt hashes. Verification tokens and Sign-in session ids are stored as SHA-256 of the raw secret. The provider injects `ctx.mailer` and sends the verification message after a successful register or resend.

## Model Experience

None, as PostgreSQL Account rows never enter a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Sign-in lifetime does not slide** — rows carry an expiry; sliding 14-day refresh is a later ticket.
- **No Ban or Deletion columns** — later tickets add those control-plane records.
