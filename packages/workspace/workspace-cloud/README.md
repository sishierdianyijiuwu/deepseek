# @deepseek-ai/dsh-workspace-cloud

English | [中文](README.zh.md)

Cloud Workspaces (`ctx.cloudWorkspaces`) for the hosted control plane: an Account creates empty directories on the control-plane filesystem, namespaced `{root}/{accountId}/{dir}/`. Metadata (id, Account, title, path, slot) lives in PostgreSQL, not as file blobs. Caps are three Workspaces per Account and 1 GiB of regular-file bytes each (ADR 0009, ADR 0017).

Config `url` is a `postgres://` / `postgresql://` connection string, or `pglite:` in tests. `root` is the control-plane directory that holds the trees. Missing `url` or `root`, a failed connection, or a schema version other than `SCHEMA_VERSION` (1) fails at load. The plugin injects `workspaceRegistry` so a created directory is also a Host Workspace the Session attach path already understands.

`createEmpty` assigns slot 0..2; a fourth create throws `CloudWorkspaceLimitError`. Startup adopts each PostgreSQL row into `workspaceRegistry` by path so a wiped KV store still lists the durable directories. `writeFile` and `deleteOwned` serialize on one per-Workspace chain; `writeFile` re-checks ownership, walks the tree, and refuses a write that would pass 1 GiB (`CloudWorkspaceQuotaError`). `owns` / `listOwned` / `getOwned` / `deleteOwned` are the Account isolation checks the Host `/api` uses. Another Account's id is a miss, not a distinct forbidden error.

Git Import and E2B copy-back are later tickets; they must call `writeFile` (or an equivalent tree ingest that uses the same cap) rather than writing the durable copy directly. Local tool/cwd writes into the Session directory also bypass `writeFile` until E2B hydrate is the ingest path.

## Model Experience

None, as cloud Workspace metadata and control-plane files never enter a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No git Import** — cloning a public repository into a new slot is a later ticket.
- **No E2B hydrate / copy-back** — execution-world sync is a later ticket; the 1 GiB cap is enforced on serialized `writeFile` today. Session cwd tool writes are not this ingest.
