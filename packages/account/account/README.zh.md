# @deepseek-ai/dsh-account

[English](README.md) | 中文

`ctx.accounts` 的 Service Definition。Account 由规范化邮箱和单向 Password 哈希标识。注册会创建 Unverified Account；`verifyEmail` 消费一次性令牌；邮箱验证后 `signIn` 签发 Sign-in session id；`signOut` 结束该 id；`lookupSignIn` 解析它、滑动其有效期，在该邮箱位于宿主 Operator 列表上时报告 `operator`，并在 Account 被 Ban 时返回 `undefined`。`requestPasswordReset` 向已验证 Account 发送一次性令牌（未知或 Unverified 地址为静默成功）。`resetPassword` 设置新 Password、消费令牌，并结束该 Account 的每一个 Sign-in session；Banned Account 仍可改 Password，且在 Ban 解除前 `signIn` 仍为 `banned`。Unverified Account 行已写入但 mailer 发送失败时，`register` 返回 `mail_failed`；Operator 关闭公开注册时返回 `registration_frozen`。未知邮箱与错误 Password 共用 `invalid_credentials`，因此登录无法枚举 Account。Banned Account 在 Password 正确时为 `banned`。`ban` / `liftBan` 设置或清除 Ban，不删除 Account 行。`deleteAccount` 抹除 Account 行（Sign-in session CASCADE）；它不是 Ban。`setRegistrationFrozen` / `isRegistrationFrozen` 控制公开注册。`lookupByEmail` / `lookupById` 返回存在性、已验证和 Ban 标志，不含 Session 正文。`recordOperatorAccess` / `listOperatorAccess` 持久化 Operator access 审计日志。`beginExecutingWorld` / `endExecutingWorld` / `executingWorldUsedMs` 按 Account 与 UTC 日持久化沙箱运行时长；`beginExecutingWorld` 返回 `started_at` 令牌，`endExecutingWorld` 只关闭该区间。`hashPassword`、`normalizeEmail` 与 `mintSecret` 是每个提供方必须使用的哈希与身份规则。

HTTP cookie 与 PostgreSQL 行由 Consumer 和提供方拥有。`SIGN_IN_COOKIE`、`cookieValue`、`runWithAccount` 与 `currentAccountId` 把已登录 Account 绑定到 Host `/api` 的 Session 隔离。`OPERATOR_ACCESS_HEADER`、`runWithOperatorAccess`、`currentOperatorAccess` 与 `viewingAccountId` 把只读 Operator access 绑定到另一个 Account；Credential 解析仍使用已登录 Operator。匿名身份不是 Account id。Ban、冻结、查找与审计的 Operator 鉴权由 HTTP Consumer 检查 `SignInLookup.operator`。

## Model Experience

None, as Account identity is a control-plane concern and never enters a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Banned Account 不能执行 Deletion** — `lookupSignIn` 为 `undefined`，因此 HTTP 路由为 `forbidden`；Ban 保留该行以供审计。
