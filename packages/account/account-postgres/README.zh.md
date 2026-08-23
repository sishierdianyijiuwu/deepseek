# @deepseek-ai/dsh-account-postgres

[English](README.md) | 中文

`ctx.accounts` 的 PostgreSQL Service Provider。配置 `url` 为 `postgres://` / `postgresql://` 连接串，或测试用的进程内 PostgreSQL 引擎 `pglite:`（`pglite:<dir>` 是目录持久化引擎）。`openSql`／`SqlClient`／`isUniqueViolation` 是共用的控制面 SQL 适配器（云 Workspace 复用它们）。`publicBaseUrl` 是验证和密码重置链接使用的 origin。`operatorEmails` 是 Operator 列表（加载时规范化；无效项会大声失败；空列表表示没有 Operator，首位注册者并不特殊）。缺少 `url` 或 `publicBaseUrl`、连接失败、或 schema 版本不是 `SCHEMA_VERSION`（5）会在加载时失败。邮箱唯一性由唯一索引保证；并发重复注册只会产生一个 Account。

Password 以 scrypt 哈希存储。验证令牌、密码重置令牌和 Sign-in session id 存储为原始密钥的 SHA-256。有效的 Sign-in session 在 `lookupSignIn` 时按 `signInTtlMs`（默认 14 天）向前滑动，同时报告 `operator`，并在 Account 被 Ban 时返回 `undefined`。scrypt 之后，`signIn` 对 Account 做 `SELECT … FOR UPDATE`，再检查 `verified_at` / `banned_at`，然后插入 Sign-in session。密码重置令牌寿命为 `passwordResetTtlMs`（默认 1 小时）；`account_id` 唯一，因此一个 Account 最多一个有效令牌。`resetPassword` 用 `DELETE … RETURNING` 消费该令牌，再替换 Password 哈希并删除每一个 Sign-in session 行；它不清除 Ban。`accounts.banned_at` 与单例 `registration_control.frozen_at` 持久化 Ban 和注册冻结。`ban` 设置 `banned_at` 并删除 Sign-in session，不删除 Account 行；`liftBan` 清除 Ban 并删除残留的 Sign-in session。`executing_world_open` 保存仍在运行的沙箱区间；`executing_world_daily` 按 UTC 日（`YYYY-MM-DD`）累计毫秒。`beginExecutingWorld` 会先按给定时刻关闭残留的未结束区间再插入；`endExecutingWorld` 把重叠的 UTC 日记入用量；提供方启动时关闭所有残留未结束区间。`deleteAccount` 会 `DELETE` Account 行；令牌、Sign-in session 与执行世界用量行 CASCADE。没有 `deleted_at` 列。冻结时 `register` 在 scrypt 之后对 `registration_control` 做 `FOR UPDATE` 再读，返回 `registration_frozen` 且不插入。`lookupByEmail` / `lookupById` 返回存在性、已验证和 Ban，包含 Banned 行。`operator_audit_log` 存储 Operator access 打开记录（`recordOperatorAccess` / `listOperatorAccess`）。该提供方注入 `ctx.mailer`，并在插入成功后发送验证消息。若发送抛出，`register` 返回 `mail_failed`；`resendVerification` 与 `requestPasswordReset` 仍是静默成功，以免 HTTP 路由枚举 Account。

## Model Experience

None, as PostgreSQL Account rows never enter a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Operator 审计行不随 CASCADE 删除** — `operator_audit_log` 没有指向 `accounts` 的外键；Deletion 会留下这些打开记录。
