/**
 * Control-plane Workspace tree size and contained-path writes.
 * @module @deepseek-ai/dsh-workspace-cloud/src/files
 */

import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
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
  let previous = 0
  try {
    const existing = await lstat(full)
    if (existing.isFile()) previous = existing.size
  } catch (error: unknown) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error
  }
  const current = await treeBytes(root)
  const extra = data.byteLength - previous
  if (current + extra > MAX_WORKSPACE_BYTES) {
    throw new CloudWorkspaceQuotaError(current, extra)
  }
  await mkdir(dirname(full), { recursive: true })
  await writeFile(full, data)
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
  try {
    return await readFile(full)
  } catch (error: unknown) {
    if ((error as { code?: string }).code === 'ENOENT' || (error as { code?: string }).code === 'EISDIR') {
      throw new CloudWorkspacePathError(relativePath)
    }
    throw error
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
