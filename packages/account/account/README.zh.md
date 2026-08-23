# @deepseek-ai/dsh-account

[English](README.md) | 中文

`ctx.accounts` 的 Service Definition。Account 由规范化邮箱和单向 Password 哈希标识。注册会创建 Unverified Account；`verifyEmail` 消费一次性令牌；邮箱验证后 `signIn` 签发 Sign-in session id；`signOut` 结束该 id；`lookupSignIn` 解析它并滑动其有效期。`requestPasswordReset` 向已验证 Account 发送一次性令牌（未知或 Unverified 地址为静默成功）。`resetPassword` 设置新 Password、消费令牌，并结束该 Account 的每一个 Sign-in session。Unverified Account 行已写入但 mailer 发送失败时，`register` 返回 `mail_failed`。未知邮箱与错误 Password 共用 `invalid_credentials`，因此登录无法枚举 Account。`hashPassword`、`normalizeEmail` 与 `mintSecret` 是每个提供方必须使用的哈希与身份规则。

HTTP cookie 与 PostgreSQL 行由 Consumer 和提供方拥有。匿名身份不是 Account id。

## Model Experience

None, as Account identity is a control-plane concern and never enters a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **没有 Ban** — Operator Ban 是后续工单；密码重置不查阅 Ban 标志。
- **没有 Session 所有权** — 此处不过滤 `session.list`；那是后续 Account 拥有 Session 的工单。
