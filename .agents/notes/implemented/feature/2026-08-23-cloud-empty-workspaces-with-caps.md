# Agent Note: Cloud empty Workspaces with caps

Status: implemented

English | [中文](2026-08-23-cloud-empty-workspaces-with-caps.zh.md)

## Problem

A hosted Account cannot pick a folder on their laptop. Workspaces have to live on the control plane, owned by that Account, with a hard bound on how many and how large they are. The local `workspaceRegistry` still adopts existing OS directories for `dsh web`; putting Account ownership, PostgreSQL metadata, and 1 GiB trees into that KV registry would mix two products.

## Decision

`@deepseek-ai/dsh-workspace-cloud` (`ctx.cloudWorkspaces`) is the hosted store: PostgreSQL rows for metadata (ownership, slot, title, path), directories at `{root}/{accountId}/{dir}/` for bytes. Caps are three Workspaces per Account and 1 GiB of regular-file bytes each. `createEmpty` fills slots 0..2; a fourth create is `CloudWorkspaceLimitError` / wire `workspace-limit`. `writeFile` and `deleteOwned` serialize on one per-Workspace chain (`writeFile` re-checks ownership after prior ops, re-reads the tree, and refuses net growth past 1 GiB / `workspace-quota-exceeded`). Cross-Account list, select, attach, write, delete, and host directory browse treat the id or path as missing / `directory-picker-unavailable`.

PostgreSQL is the source of truth for slots and ownership. Startup adopts each row into `workspaceRegistry` by path so a wiped KV store still serves list/create; a new registry id is written back to the row. Title updates write both stores. Session membership still lives on the registry entity.

When the plugin is composed, Host `workspace.list` returns only that Account's Workspaces, `emptyCreate: true`, and archived Session ids accounted under those Workspaces; `workspace.create` ignores laptop paths and creates empty; `session.create` requires an owned `workspaceId` (`workspace-required`). `host.pickDirectory` / `listDirectory` / `createDirectory` fail. The hosted bundle disables `directory-picker` and loads this plugin with `DSH_POSTGRES_URL` and `DSH_WORKSPACE_ROOT`. The Web picker uses `emptyCreate` to add a Workspace without the native directory flow; a failed empty create retries empty create, not a folder chooser.

Git Import and E2B copy-back are not this decision; they must ingest through the same cap (`writeFile` or an equivalent tree write). Session cwd tool writes bypass `writeFile` until E2B hydrate is that ingest.

## Alternatives considered

**Extend `workspaceRegistry` with optional Account columns.** Rejected: that registry is path-adoption over the storage domain, process-global, and not PostgreSQL. Hosted metadata belongs in Postgres per ADR 0017; dual-writing ownership onto KV would leave two sources of truth.

**A second HTTP surface besides Host `/api`.** Rejected: the spec's testing seam is the existing RPC. Caps and isolation are `workspace.*` / `session.create` over the Sign-in cookie.

**Configurable cap sizes.** Rejected: ADR 0009 is a product invariant, not a deployment tunable. HTTP tests observe 1 GiB by pre-seeding a truncated file, then `workspace.write` of one extra byte.

## Consequences

Hosted UI add-workspace no longer depends on a directory picker, and hosted `/api` cannot browse the control-plane disk. Local `dsh web` is unchanged when `cloudWorkspaces` is absent. Durable bytes stay ordinary files; Postgres never stores the tree. Import (#8) and E2B hydrate (#9) reuse `writeFile`'s cap rather than inventing a second quota check.
