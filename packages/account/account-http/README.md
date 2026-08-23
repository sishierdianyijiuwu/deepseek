# @deepseek-ai/dsh-account-http

English | [中文](README.zh.md)

HTTP Consumer that registers unauthenticated auth routes on `ctx.webServer` beside `/api`:

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/register` | `{ email, password }` → Unverified Account + mailer send |
| POST | `/auth/sign-in` | `{ email, password }` → Sign-in session cookie |
| POST | `/auth/sign-out` | end the presented Sign-in session |
| POST | `/auth/resend-verification` | `{ email }` → new mail when unverified |
| GET | `/auth/me` | current Sign-in session from the cookie |
| GET | `/verify` | `?token=` named host route; redirects to `/?verified=ok` or `/?verified=invalid` |
| HEAD | `/verify` | 200; does not consume the token |

The Sign-in session id is an HTTP-only `dsh_sign_in` cookie (`Path=/; SameSite=Lax`). Config `cookieSecure` adds `Secure` for HTTPS reverse-proxy deployments. When `ctx.accounts` is composed, the Host `/api` carrier (`dsh-client-connection`) requires this cookie and binds the Account for Session isolation; auth and static routes stay callable without it. Business outcomes are HTTP 200 JSON `{ ok: true }` or `{ ok: false, error: { code, message } }` (`mail_failed` when the Unverified Account row exists but the mailer rejected the send); carrier failures use 400/405/413/415/404.

## Model Experience

None, as auth HTTP is a browser-to-control-plane carrier and never enters a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Cookie name is a protocol constant** — not a product name; product copy still says Sign-in session.
