# @deepseek-ai/dsh-account-http

[English](README.md) | 中文

在 `ctx.webServer` 上、`/api` 旁边注册未认证鉴权路由的 HTTP Consumer：

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/auth/register` | `{ email, password }` → Unverified Account + 邮件发送 |
| POST | `/auth/sign-in` | `{ email, password }` → Sign-in session cookie |
| POST | `/auth/sign-out` | 结束当前出示的 Sign-in session |
| POST | `/auth/delete` | 对已登录 Account 执行 Deletion；清除 cookie |
| POST | `/auth/resend-verification` | `{ email }` → 未验证时重发邮件 |
| POST | `/auth/request-password-reset` | `{ email }` → 已验证时发送重置邮件；始终 `{ ok: true }` |
| POST | `/auth/reset-password` | `{ token, password }` → 新 Password；结束每一个 Sign-in session |
| GET | `/auth/me` | 从 cookie 读取当前 Sign-in session；滑动有效期、刷新 `Max-Age`，并报告 `operator` |
| POST | `/auth/operator/ban` | `{ email }` → Ban；需要 Operator cookie |
| POST | `/auth/operator/lift-ban` | `{ email }` → 解除 Ban；需要 Operator cookie |
| POST | `/auth/operator/freeze-registration` | `{ frozen }` → 冻结或解冻公开注册 |
| GET | `/auth/operator/registration` | 对 Operator 返回 `{ ok: true, frozen }` |
| GET | `/auth/operator/account` | `?email=` → 存在性、已验证、Banned；不含 Session 正文 |
| GET | `/auth/operator/audit` | `{ ok: true, items }` Operator access 打开记录，最新在前 |
| GET | `/verify` | `?token=` 具名宿主路由；重定向到 `/?verified=ok` 或 `/?verified=invalid` |
| HEAD | `/verify` | 200；不消费令牌 |
| GET | `/reset` | `?token=` 具名宿主路由；重定向到 `/?reset=<token>` 且不消费令牌 |
| HEAD | `/reset` | 200；不消费令牌 |

Sign-in session id 放在 HTTP-only 的 `dsh_sign_in` cookie（`Path=/; SameSite=Lax`；带 `Max-Age`，因此关闭浏览器不会结束它）。配置 `cookieSecure` 会为 HTTPS 反向代理部署加上 `Secure`。当组合了 `ctx.accounts` 时，Host `/api` 承载层（`dsh-client-connection`）要求此 cookie，并绑定 Account 以做 Session 隔离；鉴权与静态路由在没有它时仍可调用。`POST /auth/delete` 要求有效 Sign-in session，`DELETE` 该 Account 行，并在组合了相应服务时抹除该 Account 的 Session、Workspace 与 Credential，然后清除 cookie。未认证调用方得到 `{ ok: false, error: { code: 'forbidden' } }`。Operator 路由要求有效 Sign-in session 且其邮箱在 Operator 列表上；未认证调用方和普通 Account 得到 `{ ok: false, error: { code: 'forbidden' } }`。业务结果是 HTTP 200 JSON `{ ok: true }` 或 `{ ok: false, error: { code, message } }`（Unverified Account 行已写入但 mailer 发送失败时为 `mail_failed`；Banned Account 出示正确 Password 时为 `banned`；公开注册关闭时为 `registration_frozen`）；承载层失败使用 400/405/413/415/404。查找不读取 Session 正文。打开另一个 Account 的 Session 日志和 Workspace 文件走 Host `/api` 的 `x-dsh-operator-access`（见 [`dsh-client-connection`](../../client/connection/README.zh.md)）。

## Model Experience

None, as auth HTTP is a browser-to-control-plane carrier and never enters a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Cookie 名是协议常量** — 不是产品名称；产品文案仍称 Sign-in session。
- **没有 Operator 控制台 UI** — 查找、Ban、冻结、审计 JSON 与只读 `/api` 是 v1 Operator 路由。
