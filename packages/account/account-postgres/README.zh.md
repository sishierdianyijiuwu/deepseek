# @deepseek-ai/dsh-account-postgres

[English](README.md) | 中文

`ctx.accounts` 的 PostgreSQL Service Provider。配置 `url` 为 `postgres://` / `postgresql://` 连接串，或测试用的进程内 PostgreSQL 引擎 `pglite:`。`publicBaseUrl` 是验证链接使用的 origin。缺少 `url` 或 `publicBaseUrl`、连接失败、或 schema 版本不是 `SCHEMA_VERSION`（1）会在加载时失败。邮箱唯一性由唯一索引保证；并发重复注册只会产生一个 Account。

Password 以 scrypt 哈希存储。验证令牌和 Sign-in session id 存储为原始密钥的 SHA-256。该提供方注入 `ctx.mailer`，并在注册或重发成功后发送验证消息。

## Model Experience

None, as PostgreSQL Account rows never enter a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Sign-in 有效期不会滑动** — 行上带有过期时间；14 天滑动刷新是后续工单。
- **没有 Ban 或 Deletion 列** — 后续工单会加入这些控制面记录。
