/**
 * Cloud Workspaces (`ctx.cloudWorkspaces`): empty Account-owned directories
 * on the control-plane filesystem, metadata in PostgreSQL, count and size caps.
 * @module @deepseek-ai/dsh-workspace-cloud
 */

import { randomUUID } from 'node:crypto'
import { mkdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AccountId } from '@deepseek-ai/dsh-account'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { writeWorkspaceFile } from './files.ts'
import { ensureSchema, SCHEMA_VERSION } from './schema.ts'
import { isUniqueViolation, openSql, type SqlClient } from './sql.ts'

export { SCHEMA_VERSION }
export { MAX_WORKSPACE_BYTES, CloudWorkspacePathError, CloudWorkspaceQuotaError } from './files.ts'
export type { CloudWorkspaceRecord } from './types.ts'

/** v1 cap: three Workspaces per Account (ADR 0009). */
export const MAX_WORKSPACES_PER_ACCOUNT = 3

/** Display title used when create omits one. */
export const DEFAULT_WORKSPACE_TITLE = 'Workspace'

/** The Account already holds {@link MAX_WORKSPACES_PER_ACCOUNT} Workspaces. */
export class CloudWorkspaceLimitError extends Error {
  constructor() {
    super(`an Account may have at most ${String(MAX_WORKSPACES_PER_ACCOUNT)} Workspaces`)
    this.name = 'CloudWorkspaceLimitError'
  }
}

/** The Workspace is missing or not owned by the signed-in Account. */
export class CloudWorkspaceNotFoundError extends Error {
  /**
   * @param workspaceId - requested id.
   */
  constructor(readonly workspaceId: WorkspaceId) {
    super(`workspace '${workspaceId}' not found`)
    this.name = 'CloudWorkspaceNotFoundError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    cloudWorkspaces: CloudWorkspaces
  }
}

/** Plugin config. */
export interface Config {
  /**
   * PostgreSQL URL (`postgres://…` / `postgresql://…`), or `pglite:` for an
   * in-process PostgreSQL engine used by tests.
   */
  url: string
  /** Control-plane directory that holds per-Account Workspace trees. */
  root: string
}

/**
 * Cloud Workspace store (`ctx.cloudWorkspaces`). Create empty directories
 * namespaced by Account, persist metadata in PostgreSQL, and enforce the
 * v1 count and size caps. The Host workspace registry still owns session
 * membership for those directories.
 */
export class CloudWorkspaces extends Service {
  static inject = ['workspaceRegistry']

  static Config: z<Config> = z.object({
    url: z.string().required(),
    root: z.string().required(),
  })

  private sql: SqlClient | undefined
  private readonly url: string
  private root: string
  private readonly owners = new Map<string, AccountId>()
  private readonly pendingPaths = new Map<string, AccountId>()

  /**
   * @param ctx - Cordis context.
   * @param config - validated provider config.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'cloudWorkspaces')
    if (config.url === '' || config.root === '') {
      throw new Error('workspace-cloud: url and root are required')
    }
    this.url = config.url
    this.root = config.root
  }

  /** Open PostgreSQL, apply schema, create the file root, and load ownership. */
  protected async [Service.init](): Promise<void> {
    const sql = await openSql(this.url)
    try {
      await ensureSchema(sql)
    } catch (error) {
      await sql.close()
      throw error
    }
    this.sql = sql
    await mkdir(this.root, { recursive: true })
    this.root = await realpath(this.root)
    await this.reloadOwners()
    this.ctx.effect(() => () => {
      this.sql = undefined
      this.owners.clear()
      void sql.close()
    }, 'workspace-cloud: close sql')
  }

  /**
   * Whether `workspaceId` is a cloud Workspace owned by `accountId`.
   * @param accountId - signed-in Account.
   * @param workspaceId - Host Workspace id.
   * @returns true when the in-memory ownership map agrees.
   */
  owns(accountId: AccountId, workspaceId: WorkspaceId): boolean {
    if (this.owners.get(workspaceId) === accountId) return true
    const workspace = this.ctx.get('workspaceRegistry')?.get(workspaceId)
    return workspace !== undefined && this.pendingPaths.get(workspace.path) === accountId
  }

  /**
   * Create an empty Workspace directory for `accountId`.
   * @param accountId - owning Account.
   * @param title - display title; omitted or blank uses {@link DEFAULT_WORKSPACE_TITLE}.
   * @returns the registry Workspace after the PG row and directory exist.
   */
  async createEmpty(accountId: AccountId, title?: string): Promise<Workspace> {
    const workspaceTitle = title !== undefined && title.trim() !== '' ? title.trim() : DEFAULT_WORKSPACE_TITLE
    for (;;) {
      const slot = await this.nextSlot(accountId)
      if (slot === undefined) throw new CloudWorkspaceLimitError()
      const dirName = randomUUID()
      const directory = join(this.root, accountId, dirName)
      await mkdir(directory, { recursive: true })
      const canonical = await realpath(directory)
      this.pendingPaths.set(canonical, accountId)
      let entity: Workspace
      try {
        entity = await this.ctx.workspaceRegistry.create(canonical, workspaceTitle)
      } catch (error) {
        this.pendingPaths.delete(canonical)
        await rm(directory, { recursive: true, force: true })
        throw error
      }
      this.pendingPaths.delete(canonical)
      this.owners.set(entity.id, accountId)
      const now = Date.now()
      try {
        await this.client().query(
          `INSERT INTO cloud_workspaces (id, account_id, title, path, slot, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [entity.id, accountId, entity.title, entity.path, slot, now, now],
        )
      } catch (error) {
        this.owners.delete(entity.id)
        await this.ctx.workspaceRegistry.delete(entity.id)
        await rm(directory, { recursive: true, force: true })
        if (isUniqueViolation(error) && (await this.nextSlot(accountId)) !== undefined) continue
        if (isUniqueViolation(error)) throw new CloudWorkspaceLimitError()
        throw error
      }
      return entity
    }
  }

  /**
   * Registry Workspaces this Account owns, in durable registry order.
   * @param accountId - owning Account.
   * @returns owned Workspaces that still exist in the registry.
   */
  listOwned(accountId: AccountId): Workspace[] {
    return this.ctx.workspaceRegistry.list().filter(workspace => this.owns(accountId, workspace.id))
  }

  /**
   * Look up one owned Workspace.
   * @param accountId - owning Account.
   * @param workspaceId - Host Workspace id.
   * @returns the registry Workspace, or `undefined` when missing or not owned.
   */
  getOwned(accountId: AccountId, workspaceId: WorkspaceId): Workspace | undefined {
    if (!this.owns(accountId, workspaceId)) return undefined
    return this.ctx.workspaceRegistry.get(workspaceId)
  }

  /**
   * Delete an owned Workspace: PostgreSQL row, registry registration, and durable files.
   * @param accountId - owning Account.
   * @param workspaceId - Host Workspace id.
   * @returns true when a row was deleted.
   */
  async deleteOwned(accountId: AccountId, workspaceId: WorkspaceId): Promise<boolean> {
    const path = await this.ownedPath(accountId, workspaceId)
    if (path === undefined) return false
    await this.client().query(
      'DELETE FROM cloud_workspaces WHERE id = $1 AND account_id = $2',
      [workspaceId, accountId],
    )
    this.owners.delete(workspaceId)
    await this.ctx.workspaceRegistry.delete(workspaceId)
    await rm(path, { recursive: true, force: true })
    return true
  }

  /**
   * Write a file into an owned Workspace, refusing a tree past 1 GiB.
   * @param accountId - owning Account.
   * @param workspaceId - Host Workspace id.
   * @param relativePath - file path inside the Workspace.
   * @param data - bytes to write.
   */
  async writeFile(
    accountId: AccountId,
    workspaceId: WorkspaceId,
    relativePath: string,
    data: Uint8Array,
  ): Promise<void> {
    const path = await this.ownedPath(accountId, workspaceId)
    if (path === undefined) throw new CloudWorkspaceNotFoundError(workspaceId)
    await writeWorkspaceFile(path, relativePath, data)
  }

  private async ownedPath(accountId: AccountId, workspaceId: WorkspaceId): Promise<string | undefined> {
    const result = await this.client().query(
      'SELECT path FROM cloud_workspaces WHERE id = $1 AND account_id = $2',
      [workspaceId, accountId],
    )
    const path = result.rows[0]?.['path']
    return typeof path === 'string' ? path : undefined
  }

  private async nextSlot(accountId: AccountId): Promise<number | undefined> {
    const result = await this.client().query(
      'SELECT slot FROM cloud_workspaces WHERE account_id = $1',
      [accountId],
    )
    const used = new Set(result.rows.map(row => Number(row['slot'])))
    for (let slot = 0; slot < MAX_WORKSPACES_PER_ACCOUNT; slot += 1) {
      if (!used.has(slot)) return slot
    }
    return undefined
  }

  private async reloadOwners(): Promise<void> {
    const result = await this.client().query('SELECT id, account_id FROM cloud_workspaces')
    this.owners.clear()
    for (const row of result.rows) {
      const id = row['id']
      const account = row['account_id']
      if (typeof id === 'string' && typeof account === 'string') {
        this.owners.set(id, account as AccountId)
      }
    }
  }

  private client(): SqlClient {
    if (this.sql === undefined) throw new Error('workspace-cloud: not started')
    return this.sql
  }
}

export default CloudWorkspaces
