# @deepseek-ai/dsh-hosted

English | [中文](README.zh.md)

Hosted-profile bundle: a patch layer over `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` that inserts the Account PostgreSQL provider, SMTP mailer, auth HTTP Consumer, register/sign-in/password-reset UI, Account-scoped Credentials, and cloud empty Workspaces. Local `dsh web` stays a separate profile without Accounts.

Required environment at load: `DSH_POSTGRES_URL`, `DSH_PUBLIC_BASE_URL`, `DSH_SMTP_HOST`, `DSH_SMTP_FROM`, `DSH_WORKSPACE_ROOT`. Optional: `DSH_SMTP_PORT` (default 587, STARTTLS when the server advertises it), `DSH_SMTP_SECURE=1` (implicit TLS, typically port 465), `DSH_SMTP_USERNAME`, `DSH_SMTP_PASSWORD`, `DSH_COOKIE_SECURE=1` (Secure Sign-in cookies for HTTPS reverse-proxy deployments), `DSH_OPERATOR_EMAILS` (comma-separated Operator emails; empty means no Operators). The web-app `directory-picker` row is disabled: hosted Workspaces are cloud directories, not host folders.

Public HTTPS terminates at the shipped Caddy reverse proxy in [`reverse-proxy/`](reverse-proxy/Caddyfile); the webserver stays on loopback. The [hosted TLS reverse-proxy cookbook](../../../docs/cookbook/hosted-tls-reverse-proxy.md) is the bring-up.

## Model Experience

Indirectly, through the plugin tree it loads; this package is a patch-list carrier and registers no model context of its own.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Does not Import git or hydrate E2B** — empty cloud Workspaces and their caps are in this layer; clone and execution-world copy are later tickets. The native/browse directory picker is disabled.
- **Does not bind `0.0.0.0` or speak TLS** — the webserver listens on loopback; HTTPS terminates at the reverse proxy in front of that port.
