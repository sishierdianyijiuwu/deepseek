# @deepseek-ai/dsh-mailer-smtp

English | [中文](README.zh.md)

SMTP Service Provider for `ctx.mailer`. Config requires `host` and `from`. `port` defaults to 587, `secure` defaults to false (implicit TLS is typically 465 / `DSH_SMTP_SECURE=1`). On a non-TLS socket, EHLO `STARTTLS` is upgraded before AUTH; AUTH without TLS requires `allowPlaintextAuth`. `timeoutMs` defaults to 15000. Multiline replies wait for a `XYZ ` (space) final line. `username` and `password` must be set together when the server requires AUTH. Missing host/from or a half-set AUTH pair fails at load.

## Model Experience

None, as SMTP delivery never enters a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No DKIM or bounce handling** — those belong to the mail infrastructure in front of this process.
- **No connection pool** — each `send` opens one TCP (or TLS) session and tears it down.
