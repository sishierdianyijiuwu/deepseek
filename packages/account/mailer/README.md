# @deepseek-ai/dsh-mailer

English | [中文](README.zh.md)

Service Definition for `ctx.mailer`. `send({ to, subject, text })` delivers one plain-text message. Transport is configuration (SMTP or a test fake); the Account vocabulary does not name SMTP. HTTP tests inject a fake and must not require live SMTP.

## Model Experience

None, as outbound mail never enters a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No HTML body or attachments** — verification and later reset messages are plain text.
- **No retry queue** — a transport failure is returned to the caller.
