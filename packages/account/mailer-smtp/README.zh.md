# @deepseek-ai/dsh-mailer-smtp

[English](README.md) | 中文

`ctx.mailer` 的 SMTP Service Provider。配置要求 `host` 与 `from`。`port` 默认为 587，`secure` 默认为 false（隐式 TLS 通常是 465 / `DSH_SMTP_SECURE=1`）。在非 TLS 套接字上，若 EHLO 宣告 `STARTTLS` 则先升级再 AUTH；未加密套接字上的 AUTH 需要 `allowPlaintextAuth`。`timeoutMs` 默认为 15000。多行回复等到 `XYZ `（空格）终结行才算完成。服务器需要 AUTH 时，`username` 与 `password` 必须一起设置。缺少 host/from 或只设置了 AUTH 的一半会在加载时失败。

## Model Experience

None, as SMTP delivery never enters a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **没有 DKIM 或退信处理** — 这些属于本进程前面的邮件基础设施。
- **没有连接池** — 每次 `send` 打开一条 TCP（或 TLS）会话并拆除。
