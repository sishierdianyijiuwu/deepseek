# Operators may open any Account's Sessions

Ordinary Accounts remain isolated from each other. An Operator may open any Account's Sessions and Workspace files **read-only** for support or audit. The Operator cannot prompt or run tools as that Account. That is a deliberate exception to ADR-0001, not a shared Workspace.

Full impersonation was rejected: it would let an Operator execute bash inside another Account's execution world.

**Status**: accepted
