# @deepseek-ai/dsh-workspace-cloud

English | [中文](README.zh.md)

Cloud Workspaces (`ctx.cloudWorkspaces`) for the hosted control plane: an Account creates empty directories or Imports a public HTTPS git URL into a new slot, namespaced `{root}/{accountId}/{dir}/`. Metadata (id, Account, title, path, slot) lives in PostgreSQL, not as file blobs. Caps are three Workspaces per Account and 1 GiB of regular-file bytes each (ADR 0009, ADR 0017).

Config `url` is a `postgres://` / `postgresql://` connection string, or `pglite:` in tests. `root` is the control-plane directory that holds the trees. Missing `url` or `root`, a failed connection, or a schema version other than `SCHEMA_VERSION` (1) fails at load. The plugin injects `workspaceRegistry` so a created directory is also a Host Workspace the Session attach path already understands.

`createEmpty` assigns slot 0..2; a fourth create throws `CloudWorkspaceLimitError`. `importPublicGit` takes one of those slots, clones a public HTTPS git remote (`https:` only, no userinfo) with credential helpers off, then refuses a tree past 1 GiB (`CloudWorkspaceQuotaError`) and frees the slot. Private remotes, other schemes, and clone failures throw `CloudWorkspaceImportUrlError` / `CloudWorkspaceImportError` and do not keep a slot. Import always lands under the calling Account's namespace; there is no target path into another Account's tree. Startup adopts each PostgreSQL row into `workspaceRegistry` by path so a wiped KV store still lists the durable directories. `writeFile` and `deleteOwned` serialize on one per-Workspace chain; `writeFile` re-checks ownership, walks the tree, and refuses a write that would pass 1 GiB (`CloudWorkspaceQuotaError`). `owns` / `listOwned` / `getOwned` / `deleteOwned` are the Account isolation checks the Host `/api` uses. Another Account's id is a miss, not a distinct forbidden error.

E2B copy-back is a later ticket; it must use the same 1 GiB cap (`writeFile` or an equivalent tree ingest) rather than writing the durable copy directly. Local tool/cwd writes into the Session directory also bypass `writeFile` until E2B hydrate is the ingest path.

## Model Experience

None, as cloud Workspace metadata and control-plane files never enter a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No E2B hydrate / copy-back** — execution-world sync is a later ticket; the 1 GiB cap is enforced on serialized `writeFile` and on Import clone ingest. Session cwd tool writes are not this ingest.
