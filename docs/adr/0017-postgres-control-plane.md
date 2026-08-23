# Accounts and control-plane records live in PostgreSQL

Account, Sign-in session, Ban, audit log, and Workspace metadata are stored in PostgreSQL from v1. SQLite-on-the-box was rejected: this is a public SaaS, and a real database is the cheaper time to adopt it. Session event logs stay as per-Account JSONL on the control plane; durable Workspace file bytes stay on the control-plane filesystem, not as database blobs.

**Status**: accepted
