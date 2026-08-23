# Tool execution runs in E2B; the control plane stays self-hosted

The Web UI, Accounts, and Session logs deploy on our server. Bash, filesystem, and network tools run in an E2B sandbox per the existing `packages/e2b` seam. Self-hosted Docker was rejected so v1 does not require container orchestration on that server. Upstream local landlock on a shared uid is not a multi-tenant boundary.

The current E2B plugin deletes the sandbox on timeout or disposal and has no volumes or pause. Durable Workspace files therefore live on the control plane and are copied into a fresh execution world for a Session, then copied back. E2B is billed on one platform API key, with per-Account runtime caps; Accounts do not bring their own E2B key.

**Status**: accepted
