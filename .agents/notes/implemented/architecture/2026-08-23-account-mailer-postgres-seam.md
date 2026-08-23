# Agent Note: Account, mailer, and PostgreSQL control-plane seam

Status: implemented

English | [中文](2026-08-23-account-mailer-postgres-seam.zh.md)

## Problem

The hosted product in `CONTEXT.md` needs an Account a visitor can register, verify by email, sign in, and sign out. Upstream DeepSeek Harness is a single-home local tool: `packages/identity` is anonymous telemetry, `packages/credentials` stores model-provider secrets, `/api` trusts loopback, and there is no mailer, no PostgreSQL, and no Sign-in session. Ticket #2 has to make an Account real without isolating Sessions or Workspaces (ticket #4) and without turning local `dsh web` into SaaS.

## Decision

A new `packages/account/` group owns the Account and mailer capability seams. Local `dsh web` is unchanged. `dsh hosted` / `--profile hosted` applies `@deepseek-ai/dsh-hosted` over base + web-app.

### Packages

| Package | Role | `ctx` key |
|---|---|---|
| `@deepseek-ai/dsh-account` | Service Definition | `accounts` |
| `@deepseek-ai/dsh-account-postgres` | PostgreSQL Service Provider | `accounts` |
| `@deepseek-ai/dsh-account-http` | HTTP Consumer | — |
| `@deepseek-ai/dsh-mailer` | Mailer Service Definition | `mailer` |
| `@deepseek-ai/dsh-mailer-smtp` | SMTP Service Provider | `mailer` |
| `@deepseek-ai/dsh-client-ui-account` | Browser overlay | — |
| `@deepseek-ai/dsh-hosted` | Hosted-profile bundle | — |

`packages/identity` and `packages/credentials` stay out of this seam.

### Auth HTTP (beside `/api`)

Unauthenticated routes are named `webServer` registrations, not `session.register` and not Typert Remotes:

| Method | Path |
|---|---|
| POST | `/auth/register` |
| POST | `/auth/sign-in` |
| POST | `/auth/sign-out` |
| POST | `/auth/resend-verification` |
| POST | `/auth/request-password-reset` |
| POST | `/auth/reset-password` |
| GET | `/auth/me` (includes `operator`) |
| POST | `/auth/operator/ban` |
| POST | `/auth/operator/lift-ban` |
| POST | `/auth/operator/freeze-registration` |
| GET | `/auth/operator/registration` |
| GET | `/verify` (`HEAD` returns 200 and does not consume the token) |
| GET | `/reset` (`HEAD` returns 200 and does not consume the token) |

`GET /verify?token=` exists because `frontend-static` 404s unknown pathnames; the handler verifies then redirects to `/?verified=ok` or `/?verified=invalid` so the SPA on `/` can show the outcome. JSON bodies are `{ ok: true }` or `{ ok: false, error: { code, message } }` at HTTP 200 for business results.

### Sign-in session cookie

The browser presents a server-side Sign-in session id in the HTTP-only cookie `dsh_sign_in` (`Path=/; SameSite=Lax`; `Max-Age` so closing the browser does not end it; `Secure` when `cookieSecure` is set). Product copy still says Sign-in session. The raw id is unguessable hex; PostgreSQL stores SHA-256 of that id. `lookupSignIn` slides a live Sign-in session forward by `signInTtlMs` (default 14 days); `/auth/me` refreshes the cookie `Max-Age`. Password reset ends every Sign-in session for that Account ([sliding and reset](../feature/2026-08-23-password-reset-sliding-sign-in.md)).

### Passwords and tokens

Passwords are scrypt one-way hashes (`scrypt$N$r$p$salt$key`), never Credentials. Verification and password-reset tokens are 32-byte secrets stored as SHA-256, single-use, with configurable `verificationTtlMs` (default 24h) and `passwordResetTtlMs` (default 1h). Duplicate email is rejected by a unique index on the normalized address; concurrent inserts yield one Account. Failed sign-in with a wrong password or unknown email returns the same `invalid_credentials`. An Unverified Account with the correct Password returns `unverified` and does not set a cookie.

### PostgreSQL

ADR 0017: Account and Sign-in session live in PostgreSQL from v1. Config `url` is `postgres://…` / `postgresql://…`, or `pglite:` for the in-process PostgreSQL engine HTTP tests use. Config `operatorEmails` is the Operator list (hosted profile: `DSH_OPERATOR_EMAILS`). Schema version is `SCHEMA_VERSION = 3`; a mismatch fails at load. `banned_at` and `registration_control.frozen_at` persist Ban and registration freeze. Session JSONL stays files. Ban and freeze live on this seam ([Operator Ban](../feature/2026-08-23-operator-ban-and-registration-freeze.md)).

### Mailer

Email is a mailer port (`ctx.mailer.send`). SMTP is configuration (`dsh-mailer-smtp`): port 587 upgrades STARTTLS when advertised, AUTH on a non-TLS socket requires `allowPlaintextAuth`, implicit TLS is `secure: true` (typically 465 / `DSH_SMTP_SECURE=1`), and one send is bounded by `timeoutMs`. Multiline replies wait for a `XYZ ` final line. If the mailer throws after the Unverified Account row is committed, `register` returns `mail_failed` (HTTP 200) so the UI can resend. HTTP tests inject a fake Mailer subclass through Loader; they never open live SMTP.

### Hosted vs web

Parent spec Out of Scope allows local `dsh web` without Accounts. The hosted bundle is a third profile template so single-home web is not silently turned into SaaS. Required hosted env: `DSH_POSTGRES_URL`, `DSH_PUBLIC_BASE_URL`, `DSH_SMTP_HOST`, `DSH_SMTP_FROM`. Optional `DSH_OPERATOR_EMAILS` is a comma-separated Operator list.

### Testing

The source of truth is Loader-composed HTTP: real `fetch` against `127.0.0.1:port`, cookie jars, a fake mailer, and a fake `Date.now` clock. Tests assert status, JSON, cookie effects, and whether the fake was invoked — not PostgreSQL rows or hash algorithms.

## Alternatives considered

**Fold Account into `packages/identity` or `packages/credentials`.** Rejected: identity is explicitly not an authenticated account, and credentials are model-provider secrets. Mixing them would collide vocabulary and storage.

**Add `session.register` / Typert `accounts/signIn` on `/api`.** Rejected by the parent spec: unauthenticated auth routes are new HTTP endpoints beside `/api`. `/api` stays the existing Host RPC; ticket #4 binds it to a Sign-in session.

**Put auth UI paths through `frontend-static` SPA rewrite.** Rejected: the dist server 404s unknown pathnames. A named `/verify` route is required for mailbox links.

**Require Accounts on every `web` profile.** Rejected: the parent spec leaves local `dsh web` as a separate profile. A hosted bundle plus `PROFILE_TEMPLATES.hosted` is the smaller product change.

**SQLite for Account rows.** Rejected by ADR 0017.

**In-process user-service test seam.** Rejected by the parent spec Testing Decisions. HTTP with a fake mailer is the one seam.

**JWT as the Sign-in session.** Rejected: product vocabulary forbids JWT as a product name, and the spec wants a server-side session id so password reset can end every Sign-in session.

## Consequences

Seven new packages and a hosted profile add Loader rows, env configuration, and a cookie on the hosted surface. Local `dsh web` still has no Account. `/api` Session methods bind the signed-in Account. Ban and registration freeze live on this seam; Deletion and Operator Session access stay later tickets. HTTP tests with PGlite, a fake mailer, and a fake clock pin register / verify / sign-in / sign-out / reset / sliding / Ban / freeze without live SMTP or a shared Postgres.
