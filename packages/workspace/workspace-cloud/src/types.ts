/**
 * Vocabulary types for cloud Workspaces on the control plane.
 * @module @deepseek-ai/dsh-workspace-cloud/src/types
 */

import type { AccountId } from '@deepseek-ai/dsh-account'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'

/** One cloud Workspace metadata row (PostgreSQL), never file bytes. */
export interface CloudWorkspaceRecord {
  /** Registry Workspace id (the Host `workspaceId`). */
  readonly id: WorkspaceId
  /** Owning Account. */
  readonly accountId: AccountId
  /** Display title. */
  readonly title: string
  /** Canonical control-plane directory, namespaced by Account. */
  readonly path: string
  /** Slot 0..2 under the per-Account count cap. */
  readonly slot: number
  /** ISO-8601 creation instant. */
  readonly createdAt: string
  /** ISO-8601 last-mutation instant. */
  readonly updatedAt: string
}
