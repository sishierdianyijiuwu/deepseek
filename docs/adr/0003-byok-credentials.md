# Each Account supplies its own model Credential

LLM calls use a Credential owned by that Account (bring your own key). The host does not pay for tokens and does not share one provider key across Accounts. A platform-paid default key was rejected for v1 because open registration would make that key an abuse target before any quota or billing exists.

**Status**: accepted
