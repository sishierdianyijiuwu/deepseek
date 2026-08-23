/**
 * Hydrate a durable Workspace into an execution-world cwd, and copy it back
 * through the 1 GiB ingest. Adapter-private `.dsh-e2b` paths are never copied.
 * @module @deepseek-ai/dsh-workspace-cloud/src/sync
 */

import { posix } from 'node:path'
import type {} from '@deepseek-ai/dsh-session/types'
import {
  CloudWorkspaceQuotaError,
  ingestWorkspaceTree,
  listWorkspaceFiles,
  MAX_WORKSPACE_BYTES,
  readWorkspaceFile,
} from './files.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Copy-back of the execution-world tree into the durable Workspace was
     * refused (the 1 GiB cap). The durable copy is unchanged. Log-only.
     */
    'workspace/copy-back-failed': { message: string; maxBytes: number }
  }
}

/** Remote directory the E2B adapters reserve; never hydrated or copied back. */
export const EXECUTION_WORLD_RUNTIME_DIR = '.dsh-e2b'

/** Duck-typed execution-world filesystem used by hydrate and copy-back. */
export interface ExecutionWorldFiles {
  /**
   * Create `path` as a directory.
   * @param path - absolute remote path.
   */
  makeDir(path: string): Promise<unknown>
  /**
   * Write one remote file.
   * @param path - absolute remote path.
   * @param data - file bytes or text.
   */
  write(path: string, data: string | Uint8Array | ArrayBuffer): Promise<unknown>
  /**
   * Read one remote file as bytes.
   * @param path - absolute remote path.
   * @param opts - `{ format: 'bytes' }`.
   */
  read(path: string, opts: { format: 'bytes' }): Promise<Uint8Array>
  /**
   * List remote entries under `path`.
   * @param path - absolute remote directory.
   * @param opts - listing depth.
   */
  list(
    path: string,
    opts: { depth: number },
  ): Promise<readonly ExecutionWorldEntry[]>
}

/** One execution-world directory entry. */
export interface ExecutionWorldEntry {
  /** Absolute remote path. */
  path: string
  /** Base name. */
  name: string
  /** Entry kind; directories are skipped as files. */
  type?: unknown
  /** Regular-file size when advertised. */
  size?: number
  /** Present when the entry is a symlink; copy-back skips it. */
  symlinkTarget?: string
}

/** Duck-typed execution world that exposes a remote filesystem. */
export interface ExecutionWorld {
  /** Remote filesystem API. */
  files: ExecutionWorldFiles
}

function isRuntimePath(relativePath: string): boolean {
  return relativePath === EXECUTION_WORLD_RUNTIME_DIR
    || relativePath.startsWith(`${EXECUTION_WORLD_RUNTIME_DIR}/`)
}

function isDirectoryEntry(entry: ExecutionWorldEntry): boolean {
  return String(entry.type) === 'dir'
}

/**
 * Copy regular files from the durable Workspace into `remoteCwd`.
 * @param durableRoot - canonical control-plane Workspace directory.
 * @param world - execution-world filesystem.
 * @param remoteCwd - absolute sandbox working directory.
 */
export async function hydrateWorkspace(
  durableRoot: string,
  world: ExecutionWorld,
  remoteCwd: string,
): Promise<void> {
  const files = await listWorkspaceFiles(durableRoot)
  await world.files.makeDir(remoteCwd)
  for (const relativePath of files) {
    if (isRuntimePath(relativePath)) continue
    const data = await readWorkspaceFile(durableRoot, relativePath)
    const remotePath = posix.join(remoteCwd, relativePath)
    await world.files.makeDir(posix.dirname(remotePath))
    await world.files.write(remotePath, Buffer.from(data))
  }
}

/**
 * Read regular files from `remoteCwd` and ingest them into the durable tree.
 * A tree past {@link MAX_WORKSPACE_BYTES} throws before the durable copy grows.
 * @param durableRoot - canonical control-plane Workspace directory.
 * @param world - execution-world filesystem.
 * @param remoteCwd - absolute sandbox working directory.
 */
export async function copyBackWorkspace(
  durableRoot: string,
  world: ExecutionWorld,
  remoteCwd: string,
): Promise<void> {
  const files = await listRemoteRegularFiles(world, remoteCwd)
  const payload: Array<{ relativePath: string; data: Uint8Array }> = []
  let total = 0
  for (const file of files) {
    const data = await world.files.read(file.remotePath, { format: 'bytes' })
    total += data.byteLength
    if (total > MAX_WORKSPACE_BYTES) throw new CloudWorkspaceQuotaError(0, total)
    payload.push({ relativePath: file.relativePath, data })
  }
  await ingestWorkspaceTree(durableRoot, payload)
}

async function listRemoteRegularFiles(
  world: ExecutionWorld,
  remoteCwd: string,
): Promise<Array<{ relativePath: string; remotePath: string }>> {
  const listed = await world.files.list(remoteCwd, { depth: 32 })
  const files: Array<{ relativePath: string; remotePath: string }> = []
  for (const entry of listed) {
    if (entry.symlinkTarget !== undefined) continue
    if (isDirectoryEntry(entry)) continue
    const relativePath = posix.relative(remoteCwd, entry.path)
    if (
      relativePath === ''
      || relativePath === '..'
      || relativePath.startsWith('../')
      || posix.isAbsolute(relativePath)
      || isRuntimePath(relativePath)
    ) continue
    files.push({ relativePath, remotePath: entry.path })
  }
  return files
}
