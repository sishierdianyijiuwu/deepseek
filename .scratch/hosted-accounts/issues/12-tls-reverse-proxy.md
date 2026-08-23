## Parent

https://github.com/sishierdianyijiuwu/deepseek/issues/1

## What to build

The public hostname is HTTPS at a reverse proxy. The dsh process still binds loopback. Binding all interfaces stays unsupported. A documented compose or equivalent can be brought up and shown to terminate TLS in front of the signed-in control plane.

## Acceptance criteria

- [ ] dsh webserver host remains loopback
- [ ] Binding all interfaces is still refused
- [ ] A reverse-proxy configuration terminates HTTPS in front of that loopback port
- [ ] A signed-in Account can use `/api` through the proxy
- [ ] Unauthenticated `/api` through the proxy is still rejected
- [ ] Verification is a documented bring-up plus an HTTP check through the proxy, not a claim that dsh itself speaks TLS

## Blocked by

- Ticket 3: Signed-in Account owns Sessions
