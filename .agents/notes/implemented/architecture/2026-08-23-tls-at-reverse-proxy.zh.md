# Agent Note: TLS terminates at a reverse proxy; dsh stays on loopback

Status: implemented

[English](2026-08-23-tls-at-reverse-proxy.md) | 中文

## Problem

托管控制平面是面向公众的 HTTPS 产品，但在 dsh 内部做 TLS，或在 Account 出现之后绑定 `0.0.0.0`，都会丢掉上游的可达性围栏，并把证书放进 agent 进程。运维仍然需要一套能跑起来的 bring-up，以及经公开主机名的 HTTP 检查。

## Decision

**dsh 继续绑定 `127.0.0.1`。** web flag 解析器仍在发布 `webStartup` 之前拒绝 `--host 0.0.0.0`。hosted profile 使用同一组 flag。

**HTTPS 在该端口前面的 Caddy 处终止。** [`packages/bundle/hosted/reverse-proxy/`](../../../../packages/bundle/hosted/reverse-proxy/Caddyfile) 提供一份把流量 `reverse_proxy` 到 `127.0.0.1:3080` 的 Caddyfile，以及一份以 `network_mode: host` 运行 Caddy 的 compose 文件，使代理能够到达主机 loopback。dsh 不是 compose 服务。Docker Desktop 不能那样使用 host 网络；cookbook 改为在主机上运行 Caddy。

**公开主机名是 `--trusted-host` 加上 `DSH_PUBLIC_BASE_URL` 和 `DSH_COOKIE_SECURE=1`。** `/api` 的 Host 围栏仍是 DNS 重绑定防御，不是 Account 认证。经代理的未认证 `/api` 是 `401 unauthorized`；已登录 Account 经同一代理使用 `/api`。

**验证是经代理的 HTTP 检查，不是 dsh 自己说 TLS。** [hosted TLS 反向代理 cookbook](../../../../docs/cookbook/hosted-tls-reverse-proxy.zh.md) 是 bring-up。包测试读取随附的 Caddyfile 与 compose；HTTP 测试在 Account `/api` 组合前面放一个 TLS 代理，断言 401／200 结果，以及对 loopback dsh 端口的 TLS 握手失败。

## Testing

`packages/bundle/web-app/tests/startup.spec.ts` 和 `apps/cli/tests/built-bin.e2e.ts` 仍拒绝 `--host 0.0.0.0`。`packages/bundle/hosted/tests/reverse-proxy.spec.ts` 钉住 Caddyfile 上游和 compose 的 host 网络。`packages/account/account-http/tests/session-isolation.http.spec.ts` 经 TLS 反向代理把未认证和已登录的 `/api` 打到 loopback dsh。

## Alternatives considered

**在 `dsh-host-webserver` 内部做 TLS。** 否决，以便证书留在代理中，承载层保持 `node:http`。

**既然已有 Account，就绑定 `0.0.0.0`。** 否决：登录不能代替监听地址围栏；代理配错时进程仍会暴露。

**只允许 SSH 访问。** 被 [ADR 0015](../../../../docs/adr/0015-tls-at-proxy.zh.md) 否决：这是公开 SaaS。

**把 dsh 放进 compose 文件。** 否决：容器化的 dsh 若发布非 loopback 端口，就会变成与 ADR 不同的绑定策略。

## Consequences

运维得到可复制的 Caddy bring-up，而无需在 dsh 里实现 TLS。Linux compose 需要 host 网络；其他 Docker 引擎在主机上运行 Caddy。公开主机名必须列入 `--trusted-host`，否则 `/api` 会在 Account 认证之前被 DNS 重绑定围栏以 `403` 拒绝。
