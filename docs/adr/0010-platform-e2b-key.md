# The host pays for E2B; Accounts do not

Execution-world time is billed to one platform `E2B_API_KEY`, not a second BYOK. Model Credentials stay per-Account (ADR-0003). Open registration makes an uncapped platform E2B key an abuse target, so each Account has a runtime cap of **60 minutes of execution-world time per UTC day**.

Asking every Account for an E2B key was rejected: E2B is infrastructure, not the user's model spend.

**Status**: accepted
