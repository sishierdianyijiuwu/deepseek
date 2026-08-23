# @deepseek-ai/dsh-account-http

English | [中文](README.zh.md)

HTTP Consumer that registers unauthenticated auth routes on `ctx.webServer` beside `/api`:

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/register` | `{ email, password }` → Unverified Account + mailer send |
| POST | `/auth/sign-in` | `{ email, password }` → Sign-in session cookie |
| POST | `/auth/sign-out` | end the presented Sign-in session |
| POST | `/auth/resend-verification` | `{ email }` → new mail when unverified |
| POST | `/auth/request-password-reset` | `{ email }` → reset mail when verified; always `{ ok: true }` |
| POST | `/auth/reset-password` | `{ token, password }` → new Password; ends every Sign-in session |
| GET | `/auth/me` | current Sign-in session from the cookie; slides lifetime, refreshes `Max-Age`, and reports `operator` |
| POST | `/auth/operator/ban` | `{ email }` → Ban; Operator cookie required |
| POST | `/auth/operator/lift-ban` | `{ email }` → lift Ban; Operator cookie required |
| POST | `/auth/operator/freeze-registration` | `{ frozen }` → freeze or unfreeze public registration |
| GET | `/auth/operator/registration` | `{ ok: true, frozen }` for an Operator |
| GET | `/verify` | `?token=` named host route; redirects to `/?verified=ok` or `/?verified=invalid` |
| HEAD | `/verify` | 200; does not consume the token |
| GET | `/reset` | `?token=` named host route; redirects to `/?reset=<token>` without consuming |
| HEAD | `/reset` | 200; does not consume the token |

The Sign-in session id is an HTTP-only `dsh_sign_in` cookie (`Path=/; SameSite=Lax`; `Max-Age` so closing the browser does not end it). Config `cookieSecure` adds `Secure` for HTTPS reverse-proxy deployments. When `ctx.accounts` is composed, the Host `/api` carrier (`dsh-client-connection`) requires this cookie and binds the Account for Session isolation; auth and static routes stay callable without it. Operator routes require a live Sign-in session whose email is on the operator list; unauthenticated callers and ordinary Accounts receive `{ ok: false, error: { code: 'forbidden' } }`. Business outcomes are HTTP 200 JSON `{ ok: true }` or `{ ok: false, error: { code, message } }` (`mail_failed` when the Unverified Account row exists but the mailer rejected the send; `banned` when a Banned Account presents the correct Password; `registration_frozen` when public registration is disabled); carrier failures use 400/405/413/415/404. These Operator routes do not read another Account's Session body.

## Model Experience

None, as auth HTTP is a browser-to-control-plane carrier and never enters a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Cookie name is a protocol constant** — not a product name; product copy still says Sign-in session.
- **No Operator Session access** — Ban and freeze do not open another Account's Session log.
