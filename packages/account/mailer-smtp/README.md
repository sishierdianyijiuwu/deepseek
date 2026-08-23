# @deepseek-ai/dsh-mailer-smtp

English | [中文](README.zh.md)

SMTP Service Provider for `ctx.mailer`. Config requires `host` and `from`. `port` defaults to 587, `secure` defaults to false. `username` and `password` must be set together when the server requires AUTH. Missing host/from or a half-set AUTH pair fails at load.

## Model Experience

None, as SMTP delivery never enters a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No DKIM or bounce handling** — those belong to the mail infrastructure in front of this process.
