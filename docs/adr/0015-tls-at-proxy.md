# TLS terminates at a reverse proxy; dsh stays on loopback

The public hostname is HTTPS in front of the control plane. The dsh process still binds `127.0.0.1`. Putting TLS inside dsh, or binding `0.0.0.0` after login exists, was rejected so the upstream reachability fence stays, and certificates stay in the proxy.

SSH-only access was rejected: this is a public SaaS.

**Status**: accepted
