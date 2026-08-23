# @deepseek-ai/dsh-hosted

English | [中文](README.zh.md)

Hosted-profile bundle: a patch layer over `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` that inserts the Account PostgreSQL provider, SMTP mailer, auth HTTP Consumer, register/sign-in/password-reset UI, Account-scoped Credentials, cloud Workspaces, and the E2B execution world (hydrate/copy-back). Local `dsh web` stays a separate profile without Accounts.

Required environment at load: `DSH_POSTGRES_URL`, `DSH_PUBLIC_BASE_URL`, `DSH_SMTP_HOST`, `DSH_SMTP_FROM`, `DSH_WORKSPACE_ROOT`, `E2B_API_KEY`. Optional: `DSH_SMTP_PORT` (default 587, STARTTLS when the server advertises it), `DSH_SMTP_SECURE=1` (implicit TLS, typically port 465), `DSH_SMTP_USERNAME`, `DSH_SMTP_PASSWORD`, `DSH_COOKIE_SECURE=1` (Secure Sign-in cookies for HTTPS reverse-proxy deployments), `DSH_OPERATOR_EMAILS` (comma-separated Operator emails; empty means no Operators), `DSH_E2B_TIMEOUT_MS` (sandbox lifetime, default 3600000). The platform E2B key is never installed inside a sandbox. The web-app `directory-picker` row is disabled: hosted Workspaces are cloud directories, not host folders. Starting an Executing Session hydrates the Account's durable Workspace into E2B; copy-back runs after each turn and when that Executing Session ends. A second Executing Session is refused until the first stops; extra tabs may view the same one.

Public HTTPS terminates at the shipped Caddy reverse proxy in [`reverse-proxy/`](reverse-proxy/Caddyfile); the webserver stays on loopback. The [hosted TLS reverse-proxy cookbook](../../../docs/cookbook/hosted-tls-reverse-proxy.md) is the bring-up.

## Model Experience

Indirectly, through the plugin tree it loads; this package is a patch-list carrier and registers no model context of its own.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Does not count daily E2B minutes** — sandbox time per UTC day is a later ticket. Copy-back past 1 GiB fails and leaves the durable copy unchanged.
- **Does not bind `0.0.0.0` or speak TLS** — the webserver listens on loopback; HTTPS terminates at the reverse proxy in front of that port.
