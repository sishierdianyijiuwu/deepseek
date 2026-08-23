# @deepseek-ai/dsh-hosted

[English](README.md) | 中文

托管 profile 组合包：在 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` 之上插入 Account 的 PostgreSQL 提供方、SMTP 邮件发送、鉴权 HTTP Consumer、注册／登录／密码重置 UI、按 Account 隔离的 Credential、云 Workspace，以及 E2B 执行世界（hydrate／回拷）。本地 `dsh web` 仍是不含 Account 的独立 profile。

加载时必需的环境变量：`DSH_POSTGRES_URL`、`DSH_PUBLIC_BASE_URL`、`DSH_SMTP_HOST`、`DSH_SMTP_FROM`、`DSH_WORKSPACE_ROOT`、`E2B_API_KEY`。可选：`DSH_SMTP_PORT`（默认 587，服务器宣告时走 STARTTLS）、`DSH_SMTP_SECURE=1`（隐式 TLS，通常是 465）、`DSH_SMTP_USERNAME`、`DSH_SMTP_PASSWORD`、`DSH_COOKIE_SECURE=1`（HTTPS 反向代理部署的 Secure Sign-in cookie）、`DSH_OPERATOR_EMAILS`（逗号分隔的 Operator 邮箱；空表示没有 Operator）、`DSH_E2B_TIMEOUT_MS`（沙箱寿命，默认 3600000）。平台 E2B 密钥绝不会安装进沙箱。web-app 的 `directory-picker` 行被禁用：托管 Workspace 是云目录，不是宿主文件夹。启动 Executing Session 会把该 Account 的持久 Workspace hydrate 进 E2B；每个 turn 结束以及该 Executing Session 结束时回拷。API 网关 inject `e2b`，因此 Host dispose 时回拷先于沙箱 kill。第二个 Executing Session 会被拒绝，直到第一个停止；额外标签页可以查看同一个。

面向公众的 HTTPS 在随附的 Caddy 反向代理（[`reverse-proxy/`](reverse-proxy/Caddyfile)）处终止；webserver 仍留在 loopback。bring-up 见 [hosted TLS 反向代理 cookbook](../../../docs/cookbook/hosted-tls-reverse-proxy.zh.md)。

## Model Experience

Indirectly, through the plugin tree it loads; this package is a patch-list carrier and registers no model context of its own.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **不计每日 E2B 分钟** — 每个 UTC 日的沙箱时长是后续工单。回拷超过 1 GiB 会失败，且不扩大持久副本。
- **不绑定 `0.0.0.0` 也不自身终止 TLS** — webserver 监听 loopback；HTTPS 在该端口前面的反向代理处终止。
