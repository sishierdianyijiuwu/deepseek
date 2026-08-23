# Agent Note: TLS terminates at a reverse proxy; dsh stays on loopback

Status: implemented

English | [中文](2026-08-23-tls-at-reverse-proxy.zh.md)

## Problem

The hosted control plane is a public HTTPS product, but putting TLS inside dsh or binding `0.0.0.0` after Accounts exist would drop the upstream reachability fence and put certificates in the agent process. Operators still need a bring-up they can run and an HTTP check through the public hostname.

## Decision

**dsh keeps binding `127.0.0.1`.** The web flag parser still rejects `--host 0.0.0.0` before `webStartup` is published. The hosted profile uses those same flags.

**HTTPS terminates at Caddy in front of that port.** [`packages/bundle/hosted/reverse-proxy/`](../../../../packages/bundle/hosted/reverse-proxy/Caddyfile) ships a Caddyfile that `reverse_proxy`s to `127.0.0.1:3080` and a compose file that runs Caddy with `network_mode: host` so the proxy can reach host loopback. dsh is not a compose service. Docker Desktop cannot use host networking that way; the cookbook runs Caddy on the host instead.

**The public hostname is a `--trusted-host` plus `DSH_PUBLIC_BASE_URL` and `DSH_COOKIE_SECURE=1`.** The `/api` Host fence is still DNS-rebinding defense, not Account authentication. Unauthenticated `/api` through the proxy is `401 unauthorized`; a signed-in Account uses `/api` through the same proxy.

**Verification is HTTP through the proxy, not dsh speaking TLS.** The [hosted TLS reverse-proxy cookbook](../../../../docs/cookbook/hosted-tls-reverse-proxy.md) is the bring-up. A package test reads the shipped Caddyfile and compose; an HTTP test fronts the Account `/api` composition with a TLS proxy and asserts the 401/200 outcomes plus a failed TLS handshake to the loopback dsh port.

## Testing

`packages/bundle/web-app/tests/startup.spec.ts` and `apps/cli/tests/built-bin.e2e.ts` still refuse `--host 0.0.0.0`. `packages/bundle/hosted/tests/reverse-proxy.spec.ts` pins the Caddyfile upstream and compose host-network. `packages/account/account-http/tests/session-isolation.http.spec.ts` drives unauthenticated and signed-in `/api` through a TLS reverse proxy onto loopback dsh.

## Alternatives considered

**TLS inside `dsh-host-webserver`.** Rejected so certificates stay in the proxy and the carrier remains `node:http`.

**Bind `0.0.0.0` now that Accounts exist.** Rejected: login is not a substitute for the listen-address fence; a misconfigured proxy would still expose the process.

**SSH-only access.** Rejected by [ADR 0015](../../../../docs/adr/0015-tls-at-proxy.md): this is a public SaaS.

**Put dsh in the compose file.** Rejected: a containerized dsh that published a non-loopback port would be a different bind policy than the ADR.

## Consequences

Operators get a copyable Caddy bring-up without a TLS implementation in dsh. Linux compose needs host networking; other Docker engines run Caddy on the host. The public hostname must be listed as `--trusted-host` or `/api` is `403` from the DNS-rebinding fence before Account auth runs.
