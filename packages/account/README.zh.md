# account/ — Account 与邮件发送

[English](README.md) | 中文

托管 Account 身份：用邮箱和密码注册、验证邮箱、登录，并可重置 Password。本组不复用 [`identity/`](../identity/README.zh.md)（匿名遥测）或 [`credentials/`](../credentials/README.zh.md)（模型提供方密钥）。

| 包 | 职责 | ctx key |
|---|---|---|
| [`account/`](account/README.zh.md) | Account Service Definition | `accounts` |
| [`account-postgres/`](account-postgres/README.zh.md) | Account 与 Sign-in session 的 PostgreSQL Service Provider | `accounts` |
| [`account-http/`](account-http/README.zh.md) | HTTP Consumer：`/api` 旁边的未认证鉴权路由 | — |
| [`mailer/`](mailer/README.zh.md) | 邮件发送端口的 Service Definition | `mailer` |
| [`mailer-smtp/`](mailer-smtp/README.zh.md) | SMTP Service Provider | `mailer` |
