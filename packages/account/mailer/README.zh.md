# @deepseek-ai/dsh-mailer

[English](README.md) | 中文

`ctx.mailer` 的 Service Definition。`send({ to, subject, text })` 投递一封纯文本消息。传输方式是配置（SMTP 或测试假实现）；Account 词汇不出现 SMTP。HTTP 测试注入假实现，不得要求真实 SMTP。

## Model Experience

None, as outbound mail never enters a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **没有 HTML 正文或附件** — 验证邮件和后续重置邮件都是纯文本。
- **没有重试队列** — 传输失败会返回给调用方。
