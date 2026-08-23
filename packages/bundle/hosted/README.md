# @deepseek-ai/dsh-hosted

English | [中文](README.zh.md)

Hosted-profile bundle: a patch layer over `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` that inserts the Account PostgreSQL provider, SMTP mailer, auth HTTP Consumer, and register/sign-in/password-reset UI. Local `dsh web` stays a separate profile without Accounts.

Required environment at load: `DSH_POSTGRES_URL`, `DSH_PUBLIC_BASE_URL`, `DSH_SMTP_HOST`, `DSH_SMTP_FROM`. Optional: `DSH_SMTP_PORT` (default 587, STARTTLS when the server advertises it), `DSH_SMTP_SECURE=1` (implicit TLS, typically port 465), `DSH_SMTP_USERNAME`, `DSH_SMTP_PASSWORD`, `DSH_COOKIE_SECURE=1`.

## Model Experience

Indirectly, through the plugin tree it loads; this package is a patch-list carrier and registers no model context of its own.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Does not isolate Sessions or Workspaces** — later tickets bind `/api` to the Sign-in session.
- **Does not bind `0.0.0.0` or terminate TLS** — the webserver still listens on loopback; TLS stays at a reverse proxy.
