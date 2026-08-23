# Full harness tools run inside a per-Account execution world

A hosted Account gets the full tool set (bash, filesystem, network), not a files-only v1. Those tools must not run as the host OS user: each Account has a strong execution world (container or equivalent). Upstream landlock/bwrap on a shared uid is not enough for hostile tenants.

**Status**: accepted
