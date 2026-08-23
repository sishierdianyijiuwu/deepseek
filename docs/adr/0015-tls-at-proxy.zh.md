# TLS terminates at a reverse proxy; dsh stays on loopback

[English](0015-tls-at-proxy.md) | 中文

公开主机名在控制平面前面是 HTTPS。dsh 进程仍绑定 `127.0.0.1`。在 dsh 内部做 TLS，或在登录已经存在之后绑定 `0.0.0.0`，已被否决，以便保留上游的可达性围栏，并把证书留在代理中。

只允许 SSH 访问已被否决：这是公开 SaaS。

**Status**: accepted
