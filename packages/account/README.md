# account/ — Account and mailer

English | [中文](README.zh.md)

Hosted Account identity: a person registers with email and password, verifies the email, and signs in. This group does not reuse [`identity/`](../identity/README.md) (anonymous telemetry) or [`credentials/`](../credentials/README.md) (model-provider secrets).

| Package | Role | ctx key |
|---|---|---|
| [`account/`](account/README.md) | Account Service Definition | `accounts` |
| [`account-postgres/`](account-postgres/README.md) | PostgreSQL Service Provider for Account and Sign-in session | `accounts` |
| [`account-http/`](account-http/README.md) | HTTP Consumer: unauthenticated auth routes beside `/api` | — |
| [`mailer/`](mailer/README.md) | Mailer port Service Definition | `mailer` |
| [`mailer-smtp/`](mailer-smtp/README.md) | SMTP Service Provider | `mailer` |
