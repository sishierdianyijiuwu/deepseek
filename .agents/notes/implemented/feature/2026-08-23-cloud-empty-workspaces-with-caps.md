# Agent Note: Cloud empty Workspaces with caps

Status: implemented

English | [中文](2026-08-23-cloud-empty-workspaces-with-caps.zh.md)

## Problem

A hosted Account cannot pick a folder on their laptop. Workspaces have to live on the control plane, owned by that Account, with a hard bound on how many and how large they are. The local `workspaceRegistry` still adopts existing OS directories for `dsh web`; putting Account ownership, PostgreSQL metadata, and 1 GiB trees into that KV registry would mix two products.

## Decision

`@deepseek-ai/dsh-workspace-cloud` (`ctx.cloudWorkspaces`) is the hosted store: PostgreSQL rows for metadata, directories at `{root}/{accountId}/{dir}/` for bytes. Caps are three Workspaces per Account and 1 GiB of regular-file bytes each. `createEmpty` fills slots 0..2; a fourth create is `CloudWorkspaceLimitError` / wire `workspace-limit`. `writeFile` walks the tree and refuses net growth past 1 GiB (`workspace-quota-exceeded`). Cross-Account list, select, attach, write, and delete treat the id as missing (`workspace-not-found`), matching Session isolation.

When the plugin is composed, Host `workspace.list` returns only that Account's Workspaces and `emptyCreate: true`; `workspace.create` ignores laptop paths and creates empty; `session.create` requires an owned `workspaceId` (`workspace-required`). The existing `workspaceRegistry` still owns session membership: cloud create registers the new directory so attach-by-cwd keeps working. The hosted bundle loads this plugin with `DSH_POSTGRES_URL` and `DSH_WORKSPACE_ROOT`. The Web picker uses `emptyCreate` to add a Workspace without the native directory flow.

Git Import and E2B copy-back are not this decision; they must ingest through the same cap (`writeFile` or an equivalent tree write).

## Alternatives considered

**Extend `workspaceRegistry` with optional Account columns.** Rejected: that registry is path-adoption over the storage domain, process-global, and not PostgreSQL. Hosted metadata belongs in Postgres per ADR 0017; dual-writing ownership onto KV would leave two sources of truth.

**A second HTTP surface besides Host `/api`.** Rejected: the spec's testing seam is the existing RPC. Caps and isolation are `workspace.*` / `session.create` over the Sign-in cookie.

**Configurable cap sizes.** Rejected: ADR 0009 is a product invariant, not a deployment tunable. HTTP tests observe 1 GiB by pre-seeding a truncated file, then `workspace.write` of one extra byte.

## Consequences

Hosted UI add-workspace no longer depends on a directory picker. Local `dsh web` is unchanged when `cloudWorkspaces` is absent. Durable bytes stay ordinary files; Postgres never stores the tree. Import (#8) and E2B hydrate (#9) reuse `writeFile`'s cap rather than inventing a second quota check.
