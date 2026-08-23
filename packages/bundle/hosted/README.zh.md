# @deepseek-ai/dsh-hosted

[English](README.md) | 中文

托管 profile 组合包：在 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` 之上插入 Account 的 PostgreSQL 提供方、SMTP 邮件发送、鉴权 HTTP Consumer 和注册／登录／密码重置 UI，并把进程级 credentials 行替换为按 Account 隔离的提供方。本地 `dsh web` 仍是不含 Account 的独立 profile。

加载时必需的环境变量：`DSH_POSTGRES_URL`、`DSH_PUBLIC_BASE_URL`、`DSH_SMTP_HOST`、`DSH_SMTP_FROM`。可选：`DSH_SMTP_PORT`（默认 587，服务器宣告时走 STARTTLS）、`DSH_SMTP_SECURE=1`（隐式 TLS，通常是 465）、`DSH_SMTP_USERNAME`、`DSH_SMTP_PASSWORD`、`DSH_COOKIE_SECURE=1`。

## Model Experience

Indirectly, through the plugin tree it loads; this package is a patch-list carrier and registers no model context of its own.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **不隔离 Workspace** — 后续工单会把 Workspace 的 list／create／Import 绑定到 Sign-in session。
- **不绑定 `0.0.0.0` 也不终止 TLS** — webserver 仍监听 loopback；TLS 仍在反向代理处终止。
