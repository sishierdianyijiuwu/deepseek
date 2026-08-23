# Cookbook: hosted TLS reverse proxy

[English](hosted-tls-reverse-proxy.md) | 中文

在 `dsh hosted` 前面接入 HTTPS，同时让 dsh 进程继续绑在 loopback（回环）上。TLS 在 Caddy 处终止；dsh 不对外说 TLS。决策见 [ADR 0015](../adr/0015-tls-at-proxy.zh.md)；[`dsh-hosted`](../../packages/bundle/hosted/README.zh.md) 拥有 Account 组合包以及随附的 [Caddyfile](../../packages/bundle/hosted/reverse-proxy/Caddyfile)。

前置条件：已构建的安装（在本检出目录运行 `pnpm run build`）、Caddy 2 或 Docker Compose，以及组合包 README 中的 hosted 环境变量（`DSH_POSTGRES_URL`、`DSH_PUBLIC_BASE_URL`、`DSH_SMTP_HOST`、`DSH_SMTP_FROM`）。

## 1. 把 dsh 绑在 loopback 上

把公开 origin 设成反向代理将服务的 HTTPS 主机名，并打开 Secure cookie：

```sh
export DSH_PUBLIC_HOST=example.com
export DSH_PUBLIC_BASE_URL=https://example.com
export DSH_COOKIE_SECURE=1
dsh hosted --no-open --trusted-host "$DSH_PUBLIC_HOST"
```

`--trusted-host` 是该公开主机名的 `/api` DNS 重绑定围栏，不是 Account 认证。不要传 `--host`，这样 webserver 绑在 `127.0.0.1:3080`。

1. 确认监听地址是 loopback（`ss -ltnp 'sport = :3080'` 或 `lsof -nP -iTCP:3080 -sTCP:LISTEN` 显示 `127.0.0.1:3080`）。
2. 确认全接口绑定仍被拒绝：`dsh hosted --host 0.0.0.0` 以非零状态退出，并输出 `error: --host 0.0.0.0 is intentionally not supported yet for safety`。

## 2. 在前面终止 HTTPS

在 Linux 上，于 `packages/bundle/hosted/reverse-proxy/` 目录：

```sh
export DSH_PUBLIC_HOST=example.com
docker compose -f compose.yml up
```

`network_mode: host` 是 Caddy 能到达主机 loopback 的方式。在 Docker Desktop 上，改为在主机上运行 Caddy：

```sh
export DSH_PUBLIC_HOST=example.com
caddy run --config packages/bundle/hosted/reverse-proxy/Caddyfile
```

Caddy 在公开主机名上提供 HTTPS，并反向代理到 `http://127.0.0.1:3080`。对 `localhost` 它使用内部 CA；对公开名称它会申请证书。

## 3. 经代理检查 `/api`

这些检查走 HTTPS。它们并不证明 dsh 自己会说 TLS。

未认证的 `/api` 会被拒绝：

```sh
curl -sS -o /tmp/dsh-unauth.out -w '%{http_code}' \
  -H 'content-type: application/json' \
  -d '{"type":"client-request","rpcId":"1","method":"session.list","payload":{}}' \
  "https://$DSH_PUBLIC_HOST/api/session.list"
```

期望 `401`，响应体为 `unauthorized`。

登录一个已验证的 Account（注册、完成邮箱 `/verify` 链接，然后）：

```sh
curl -sS -c /tmp/dsh-cookies -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"correct-horse"}' \
  "https://$DSH_PUBLIC_HOST/auth/sign-in"
curl -sS -b /tmp/dsh-cookies -o /tmp/dsh-auth.out -w '%{http_code}' \
  -H 'content-type: application/json' \
  -d '{"type":"client-request","rpcId":"2","method":"session.list","payload":{}}' \
  "https://$DSH_PUBLIC_HOST/api/session.list"
```

期望 `200` 和 JSON RPC 结果。`curl http://127.0.0.1:3080/auth/me` 仍在 loopback HTTP 端口上应答；对同一端口做 TLS 握手会失败。
