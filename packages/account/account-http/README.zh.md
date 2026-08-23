# @deepseek-ai/dsh-account-http

[English](README.md) | 中文

在 `ctx.webServer` 上、`/api` 旁边注册未认证鉴权路由的 HTTP Consumer：

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/auth/register` | `{ email, password }` → Unverified Account + 邮件发送 |
| POST | `/auth/sign-in` | `{ email, password }` → Sign-in session cookie |
| POST | `/auth/sign-out` | 结束当前出示的 Sign-in session |
| POST | `/auth/resend-verification` | `{ email }` → 未验证时重发邮件 |
| GET | `/auth/me` | 从 cookie 读取当前 Sign-in session |
| GET | `/verify` | `?token=` 具名宿主路由；重定向到 `/?verified=ok` 或 `/?verified=invalid` |
| HEAD | `/verify` | 200；不消费令牌 |

Sign-in session id 放在 HTTP-only 的 `dsh_sign_in` cookie（`Path=/; SameSite=Lax`）。配置 `cookieSecure` 会为 HTTPS 反向代理部署加上 `Secure`。当组合了 `ctx.accounts` 时，Host `/api` 承载层（`dsh-client-connection`）要求此 cookie，并绑定 Account 以做 Session 隔离；鉴权与静态路由在没有它时仍可调用。业务结果是 HTTP 200 JSON `{ ok: true }` 或 `{ ok: false, error: { code, message } }`（Unverified Account 行已写入但 mailer 发送失败时为 `mail_failed`）；承载层失败使用 400/405/413/415/404。

## Model Experience

None, as auth HTTP is a browser-to-control-plane carrier and never enters a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Cookie 名是协议常量** — 不是产品名称；产品文案仍称 Sign-in session。
