# @deepseek-ai/dsh-account-postgres

[English](README.md) | 中文

`ctx.accounts` 的 PostgreSQL Service Provider。配置 `url` 为 `postgres://` / `postgresql://` 连接串，或测试用的进程内 PostgreSQL 引擎 `pglite:`。`publicBaseUrl` 是验证和密码重置链接使用的 origin。缺少 `url` 或 `publicBaseUrl`、连接失败、或 schema 版本不是 `SCHEMA_VERSION`（2）会在加载时失败。邮箱唯一性由唯一索引保证；并发重复注册只会产生一个 Account。

Password 以 scrypt 哈希存储。验证令牌、密码重置令牌和 Sign-in session id 存储为原始密钥的 SHA-256。有效的 Sign-in session 在 `lookupSignIn` 时按 `signInTtlMs`（默认 14 天）向前滑动。`resetPassword` 替换 Password 哈希、删除该 Account 的重置令牌，并删除每一个 Sign-in session 行。该提供方注入 `ctx.mailer`，并在插入成功后发送验证消息。若发送抛出，`register` 返回 `mail_failed`；`resendVerification` 与 `requestPasswordReset` 仍是静默成功，以免 HTTP 路由枚举 Account。

## Model Experience

None, as PostgreSQL Account rows never enter a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **没有 Ban 或 Deletion 列** — 后续工单会加入这些控制面记录。
