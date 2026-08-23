/**
 * Control-plane Workspace tree size and contained-path writes.
 * @module @deepseek-ai/dsh-workspace-cloud/src/files
 */

import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** v1 cap: 1 GiB of file bytes per Workspace (ADR 0009). */
export const MAX_WORKSPACE_BYTES = 1024 * 1024 * 1024

/** A relative path escaped the Workspace directory or was empty. */
export class CloudWorkspacePathError extends Error {
  /**
   * @param relativePath - caller-supplied path.
   */
  constructor(readonly relativePath: string) {
    super(`workspace path '${relativePath}' is not a file inside the Workspace`)
    this.name = 'CloudWorkspacePathError'
  }
}

/** Writing the file would take the Workspace past {@link MAX_WORKSPACE_BYTES}. */
export class CloudWorkspaceQuotaError extends Error {
  /**
   * @param currentBytes - tree size before this write.
   * @param extraBytes - net bytes this write would add.
   */
  constructor(readonly currentBytes: number, readonly extraBytes: number) {
    super(
      `workspace would exceed ${String(MAX_WORKSPACE_BYTES)} bytes `
      + `(${String(currentBytes)} + ${String(extraBytes)})`,
    )
    this.name = 'CloudWorkspaceQuotaError'
  }
}

/**
 * Resolve `relativePath` under `root` and reject escape, absolute, empty, and NUL paths.
 * @param root - canonical Workspace directory.
 * @param relativePath - POSIX-ish relative file path.
 * @returns the absolute file path.
 */
export function resolveWorkspaceFile(root: string, relativePath: string): string {
  if (relativePath === '' || relativePath.includes('\0') || isAbsolute(relativePath)) {
    throw new CloudWorkspacePathError(relativePath)
  }
  const parts = relativePath.replaceAll('\\', '/').split('/').filter(part => part !== '' && part !== '.')
  if (parts.length === 0 || parts.some(part => part === '..')) {
    throw new CloudWorkspacePathError(relativePath)
  }
  const full = resolve(root, ...parts)
  const rel = relative(root, full)
  if (rel === '' || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    throw new CloudWorkspacePathError(relativePath)
  }
  return full
}

/**
 * Sum regular-file sizes under `dir`. Symlinks are skipped (not followed).
 * @param dir - directory to walk.
 * @returns total byte size of regular files.
 */
export async function treeBytes(dir: string): Promise<number> {
  let total = 0
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error: unknown) {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return 0
    throw error
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      total += await treeBytes(full)
      continue
    }
    if (!entry.isFile()) continue
    total += (await lstat(full)).size
  }
  return total
}

/**
 * Write `data` into a contained relative path, refusing a tree that would exceed 1 GiB.
 * @param root - canonical Workspace directory.
 * @param relativePath - file path inside the Workspace.
 * @param data - bytes to write (replacement).
 */
export async function writeWorkspaceFile(
  root: string,
  relativePath: string,
  data: Uint8Array,
): Promise<void> {
  const full = resolveWorkspaceFile(root, relativePath)
  await mkdir(dirname(full), { recursive: true })
  const previous = await containedRegularFileSize(root, full, relativePath)
  const current = await treeBytes(root)
  const extra = data.byteLength - previous
  if (current + extra > MAX_WORKSPACE_BYTES) {
    throw new CloudWorkspaceQuotaError(current, extra)
  }
  await writeNoFollow(full, relativePath, data)
}

/**
 * Walk from `root` to `full` and refuse any symlink component.
 * @param root - canonical Workspace directory.
 * @param full - resolved file path under root.
 * @param relativePath - caller-supplied path (error payload).
 * @returns existing regular-file size, or 0 when the leaf does not exist.
 */
async function containedRegularFileSize(
  root: string,
  full: string,
  relativePath: string,
): Promise<number> {
  let current = root
  const parts = relative(root, full).split(sep).filter(part => part !== '')
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index] as string)
    let existing
    try {
      existing = await lstat(current)
    } catch (error: unknown) {
      if ((error as { code?: string }).code === 'ENOENT') {
        if (index === parts.length - 1) return 0
        throw new CloudWorkspacePathError(relativePath)
      }
      throw error
    }
    if (existing.isSymbolicLink()) {
      if (index < parts.length - 1) throw new CloudWorkspacePathError(relativePath)
      return 0
    }
    if (index === parts.length - 1) return existing.isFile() ? existing.size : 0
  }
  return 0
}

/**
 * Replace `full` without following a final-path symlink.
 * @param full - resolved file path under the Workspace.
 * @param relativePath - caller-supplied path (error payload).
 * @param data - bytes to write.
 */
async function writeNoFollow(full: string, relativePath: string, data: Uint8Array): Promise<void> {
  let handle
  try {
    handle = await open(full, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (error: unknown) {
    const code = (error as { code?: string }).code
    if (code === 'ELOOP' || code === 'EPERM') throw new CloudWorkspacePathError(relativePath)
    if (code !== 'ENOENT') throw error
    handle = await open(full, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL)
  }
  try {
    await handle.truncate(data.byteLength)
    await handle.write(data, 0, data.byteLength, 0)
  } finally {
    await handle.close()
  }
}

/**
 * List regular files under `root` as POSIX-relative paths. Symlinks are skipped.
 * @param root - canonical Workspace directory.
 * @returns sorted relative paths.
 */
export async function listWorkspaceFiles(root: string): Promise<string[]> {
  const files: string[] = []
  await collectWorkspaceFiles(root, '', files)
  files.sort()
  return files
}

/**
 * Read one contained relative file.
 * @param root - canonical Workspace directory.
 * @param relativePath - file path inside the Workspace.
 * @returns file bytes.
 */
export async function readWorkspaceFile(root: string, relativePath: string): Promise<Uint8Array> {
  const full = resolveWorkspaceFile(root, relativePath)
  let info
  try {
    info = await lstat(full)
  } catch (error: unknown) {
    if ((error as { code?: string }).code === 'ENOENT') {
      throw new CloudWorkspacePathError(relativePath)
    }
    throw error
  }
  if (!info.isFile()) throw new CloudWorkspacePathError(relativePath)
  return readFile(full)
}

/**
 * Replace the durable Workspace tree with `files` after refusing a tree past 1 GiB.
 * The durable directory is not modified when the incoming tree exceeds the cap.
 * @param root - canonical Workspace directory.
 * @param files - POSIX-relative regular files and their bytes.
 */
export async function ingestWorkspaceTree(
  root: string,
  files: ReadonlyArray<{ relativePath: string; data: Uint8Array }>,
): Promise<void> {
  const unique = new Map<string, Uint8Array>()
  let total = 0
  for (const file of files) {
    resolveWorkspaceFile(root, file.relativePath)
    const previous = unique.get(file.relativePath)
    if (previous !== undefined) total -= previous.byteLength
    unique.set(file.relativePath, file.data)
    total += file.data.byteLength
  }
  if (total > MAX_WORKSPACE_BYTES) throw new CloudWorkspaceQuotaError(0, total)
  const keep = new Set(unique.keys())
  const existing = await listWorkspaceFiles(root)
  for (const relativePath of existing) {
    if (keep.has(relativePath)) continue
    const full = resolveWorkspaceFile(root, relativePath)
    try {
      await unlink(full)
    } catch (error: unknown) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error
    }
  }
  for (const [relativePath, data] of unique) {
    await writeWorkspaceFile(root, relativePath, data)
  }
}

async function collectWorkspaceFiles(dir: string, prefix: string, out: string[]): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error: unknown) {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return
    throw error
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectWorkspaceFiles(full, relativePath, out)
      continue
    }
    if (entry.isFile()) out.push(relativePath)
  }
}
