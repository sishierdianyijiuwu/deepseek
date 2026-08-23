# @deepseek-ai/dsh-account

[English](README.md) | 中文

`ctx.accounts` 的 Service Definition。Account 由规范化邮箱和单向 Password 哈希标识。注册会创建 Unverified Account；`verifyEmail` 消费一次性令牌；邮箱验证后 `signIn` 签发 Sign-in session id；`signOut` 与 `lookupSignIn` 结束或解析该 id。未知邮箱与错误 Password 共用 `invalid_credentials`，因此登录无法枚举 Account。`hashPassword`、`normalizeEmail` 与 `mintSecret` 是每个提供方必须使用的哈希与身份规则。

HTTP cookie 与 PostgreSQL 行由 Consumer 和提供方拥有。匿名身份不是 Account id。

## Model Experience

None, as Account identity is a control-plane concern and never enters a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **没有密码重置或 Ban** — 后续工单负责重置令牌、滑动 Sign-in 有效期和 Operator Ban。
- **没有 Session 所有权** — 此处不过滤 `session.list`；那是后续 Account 拥有 Session 的工单。
