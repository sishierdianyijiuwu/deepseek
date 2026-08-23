# Cookbook: hosted TLS reverse proxy

English | [中文](hosted-tls-reverse-proxy.zh.md)

Bring up HTTPS in front of `dsh hosted` while the dsh process stays on loopback. TLS terminates at Caddy; dsh does not speak TLS. [ADR 0015](../adr/0015-tls-at-proxy.md) is the decision; [`dsh-hosted`](../../packages/bundle/hosted/README.md) owns the Account bundle and the shipped [Caddyfile](../../packages/bundle/hosted/reverse-proxy/Caddyfile).

Prerequisites: a built installation (`pnpm run build` from this checkout), Caddy 2 or Docker Compose, and the hosted environment from the bundle README (`DSH_POSTGRES_URL`, `DSH_PUBLIC_BASE_URL`, `DSH_SMTP_HOST`, `DSH_SMTP_FROM`).

## 1. Bind dsh on loopback

Set the public origin to the HTTPS hostname the reverse proxy will serve, and turn on Secure cookies:

```sh
export DSH_PUBLIC_HOST=example.com
export DSH_PUBLIC_BASE_URL=https://example.com
export DSH_COOKIE_SECURE=1
dsh hosted --no-open --trusted-host "$DSH_PUBLIC_HOST"
```

`--trusted-host` is the `/api` DNS-rebinding fence for that public hostname, not Account authentication. Leave `--host` unset so the webserver binds `127.0.0.1:3080`.

1. Confirm the listen address is loopback (`ss -ltnp 'sport = :3080'` or `lsof -nP -iTCP:3080 -sTCP:LISTEN` shows `127.0.0.1:3080`).
2. Confirm all-interfaces bind is still refused: `dsh hosted --host 0.0.0.0` exits nonzero with `error: --host 0.0.0.0 is intentionally not supported yet for safety`.

## 2. Terminate HTTPS in front

On Linux, from `packages/bundle/hosted/reverse-proxy/`:

```sh
export DSH_PUBLIC_HOST=example.com
docker compose -f compose.yml up
```

`network_mode: host` is how Caddy reaches host loopback. On Docker Desktop, run Caddy on the host instead:

```sh
export DSH_PUBLIC_HOST=example.com
caddy run --config packages/bundle/hosted/reverse-proxy/Caddyfile
```

Caddy serves HTTPS on the public hostname and reverse-proxies to `http://127.0.0.1:3080`. For `localhost` it uses its internal CA; for a public name it obtains a certificate.

## 3. Check `/api` through the proxy

These checks go through HTTPS. They do not prove that dsh itself speaks TLS.

Unauthenticated `/api` is rejected:

```sh
curl -sS -o /tmp/dsh-unauth.out -w '%{http_code}' \
  -H 'content-type: application/json' \
  -d '{"type":"client-request","rpcId":"1","method":"session.list","payload":{}}' \
  "https://$DSH_PUBLIC_HOST/api/session.list"
```

Expect `401` and a body of `unauthorized`.

Sign in a verified Account (register, complete the mailbox `/verify` link, then):

```sh
curl -sS -c /tmp/dsh-cookies -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"correct-horse"}' \
  "https://$DSH_PUBLIC_HOST/auth/sign-in"
curl -sS -b /tmp/dsh-cookies -o /tmp/dsh-auth.out -w '%{http_code}' \
  -H 'content-type: application/json' \
  -d '{"type":"client-request","rpcId":"2","method":"session.list","payload":{}}' \
  "https://$DSH_PUBLIC_HOST/api/session.list"
```

Expect `200` and a JSON RPC result. `curl http://127.0.0.1:3080/auth/me` still answers on the loopback HTTP port; a TLS handshake to that same port fails.
