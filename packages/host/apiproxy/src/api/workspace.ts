/**
 * workspace domain contract. Wire projection of the host-side workspace
 * entity (@deepseek-ai/dsh-workspace): a stable id over a directory path,
 * a display title, and the ordered session account. Method signatures are the
 * source of truth, same as the sessions domain.
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { RpcRequest, RpcResponse } from './rpc.ts'

/**
 * Wire-side workspace id brand. Deliberately re-declared here rather than
 * imported from dsh-workspace: api/ must stay browser-importable with zero
 * host-package dependencies, and the brand string matches, so both sides
 * agree structurally.
 */
export type WorkspaceId = Branded<'WorkspaceId'>

/** One workspace row: the record projection every workspace.* value carries. */
export interface WorkspaceView {
  workspaceId: WorkspaceId
  /** Canonical directory path (host-side realpath canon). */
  path: string
  /** Display title (defaults to the path basename at create). */
  title: string
  /**
   * Sessions accounted under this workspace, in manually owned order
   * (attach prepends, insertSessionBefore reorders; activity never does).
   */
  sessionIds: SessionId[]
  /** ISO-8601 creation instant. */
  createdAt: string
  /** ISO-8601 last-mutation instant. */
  updatedAt: string
}

/** Workspace-domain unary methods (the map keys workspace.* of RpcMethodMap). */
export interface WorkspaceApi {
  /**
   * Lists workspaces in the registry's durable display order, plus the
   * registry-global archive set (the reconnect baseline of
   * `host/archived-sessions-changed`). Archived sessions stay in their
   * workspace's `sessionIds` account; grouping surfaces hide them.
   * When cloud Workspaces are composed, `items` is the signed-in Account's
   * Workspaces only and `emptyCreate` is true. When Accounts are composed,
   * `archivedSessionIds` is that Account's archived Sessions (live owner or
   * accounted under its Workspaces), not the process-global set.
   */
  list(request: RpcRequest<{}>): Promise<RpcResponse<{
    items: WorkspaceView[]
    archivedSessionIds: SessionId[]
    emptyCreate?: boolean
  }>>

  /**
   * Local: creates (or idempotently resolves) a workspace over an EXISTING
   * directory (`path` required; a missing or non-directory path fails with
   * `workspace-invalid-path`). Cloud: creates an empty Account-owned Workspace
   * (`path` must be omitted; a fourth Workspace fails with `workspace-limit`).
   */
  create(request: RpcRequest<{ path?: string; title?: string }>):
  Promise<RpcResponse<{ workspace: WorkspaceView; created: boolean }>>

  /**
   * Cloud: clones a public HTTPS git URL into a new Account-owned Workspace.
   * Credential-bearing, non-HTTPS, and private remotes fail with
   * `workspace-import-refused`. A fourth Workspace fails with `workspace-limit`;
   * a tree past 1 GiB fails with `workspace-quota-exceeded`. Local Hosts
   * without cloud Workspaces also fail with `workspace-import-refused`.
   */
  import(request: RpcRequest<{ gitUrl: string; title?: string }>):
  Promise<RpcResponse<{ workspace: WorkspaceView; created: boolean }>>

  /**
   * Renames a workspace. `title` is trimmed and must be non-empty
   * (schema-enforced). An unknown id fails with `workspace-not-found`; a
   * title equal to another workspace's fails with `workspace-name-conflict`.
   * Renaming to the current title is a no-op success (no durable write).
   */
  rename(request: RpcRequest<{ workspaceId: WorkspaceId; title: string }>):
  Promise<RpcResponse<{ workspace: WorkspaceView }>>

  /**
   * Removes one Workspace. Local: drops only the registration; the directory
   * and session logs remain and those Sessions become ungrouped. Cloud: also
   * deletes the PostgreSQL row and the durable control-plane tree so the
   * Account frees a slot. An unknown id fails with `workspace-not-found`.
   */
  delete(request: RpcRequest<{ workspaceId: WorkspaceId }>):
  Promise<RpcResponse<{ deleted: true }>>

  /**
   * Moves one Workspace within the registry display order,
   * DOM-insertBefore-like. An omitted anchor appends to the end.
   */
  insertBefore(request: RpcRequest<{
    workspaceId: WorkspaceId
    beforeWorkspaceId?: WorkspaceId
  }>): Promise<RpcResponse<{ workspaceIds: WorkspaceId[] }>>

  /**
   * Moves an accounted session within its workspace's manual order,
   * DOM-insertBefore-like: with `beforeSessionId` the session is inserted
   * before that anchor; omitted appends to the end. An unknown workspace
   * fails with `workspace-not-found`; a session or anchor not accounted by
   * the workspace fails with `workspace-move-invalid`. A move to the current
   * position is a no-op success.
   */
  insertSessionBefore(request: RpcRequest<{
    workspaceId: WorkspaceId
    sessionId: SessionId
    beforeSessionId?: SessionId
  }>): Promise<RpcResponse<{ workspace: WorkspaceView }>>

  /**
   * Adds one session to the registry-global archive set: the session
   * disappears from every grouping surface but keeps its session log and its
   * workspace accounting slot (a future unarchive restores its position).
   * Idempotent for an already archived id. A session neither live nor in
   * session persistence fails with `session-not-found`. When Accounts are
   * composed, another Account's session is that same miss, and the returned
   * set is the viewer's archived ids (same snapshot the changed frame carries).
   */
  archiveSession(request: RpcRequest<{ sessionId: SessionId }>):
  Promise<RpcResponse<{ archivedSessionIds: SessionId[] }>>

  /**
   * Write one utf8 file into a cloud Workspace the signed-in Account owns.
   * A tree that would exceed 1 GiB fails with `workspace-quota-exceeded`.
   * Unknown or other-Account ids fail with `workspace-not-found`.
   */
  write(request: RpcRequest<{ workspaceId: WorkspaceId; path: string; data: string }>):
  Promise<RpcResponse<{ written: true }>>
}
