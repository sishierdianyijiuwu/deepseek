import { mkdir, open, readFile, symlink, writeFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CloudWorkspacePathError,
  CloudWorkspaceQuotaError,
  MAX_WORKSPACE_BYTES,
  ingestWorkspaceTree,
  listWorkspaceFiles,
  readWorkspaceFile,
  resolveWorkspaceFile,
  treeBytes,
  writeWorkspaceFile,
} from '../src/files.ts'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function stage(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'dsh-cloud-files-'))
  return root
}

describe('resolveWorkspaceFile', () => {
  it('rejects empty, absolute, parent, and NUL paths', async () => {
    const dir = await stage()
    expect(() => resolveWorkspaceFile(dir, '')).toThrow(CloudWorkspacePathError)
    expect(() => resolveWorkspaceFile(dir, '/etc/passwd')).toThrow(CloudWorkspacePathError)
    expect(() => resolveWorkspaceFile(dir, '../escape')).toThrow(CloudWorkspacePathError)
    expect(() => resolveWorkspaceFile(dir, 'ok/../../escape')).toThrow(CloudWorkspacePathError)
    expect(() => resolveWorkspaceFile(dir, 'a\0b')).toThrow(CloudWorkspacePathError)
    expect(() => resolveWorkspaceFile(dir, '.')).toThrow(CloudWorkspacePathError)
  })

  it('resolves a nested relative file under the root', async () => {
    const dir = await stage()
    expect(resolveWorkspaceFile(dir, 'src/main.ts')).toBe(join(dir, 'src', 'main.ts'))
    expect(resolveWorkspaceFile(dir, 'src//./main.ts')).toBe(join(dir, 'src', 'main.ts'))
  })
})

describe('treeBytes and writeWorkspaceFile', () => {
  it('counts regular files, skips symlinks, and writes under the cap', async () => {
    const dir = await stage()
    await writeFile(join(dir, 'a.txt'), 'hello')
    await mkdir(join(dir, 'sub'))
    await writeFile(join(dir, 'sub', 'b.txt'), 'world!')
    await symlink(join(dir, 'a.txt'), join(dir, 'link'))
    expect(await treeBytes(dir)).toBe(11)
    expect(await treeBytes(join(dir, 'missing'))).toBe(0)
    expect(await treeBytes(join(dir, 'a.txt'))).toBe(0)

    await writeWorkspaceFile(dir, 'sub/c.txt', Buffer.from('x'))
    expect(await treeBytes(dir)).toBe(12)
    expect(await listWorkspaceFiles(dir)).toEqual(['a.txt', 'sub/b.txt', 'sub/c.txt'])
    expect(Buffer.from(await readWorkspaceFile(dir, 'sub/c.txt')).toString()).toBe('x')
    await expect(readWorkspaceFile(dir, 'missing.txt')).rejects.toBeInstanceOf(CloudWorkspacePathError)
    await expect(readWorkspaceFile(dir, 'link')).rejects.toBeInstanceOf(CloudWorkspacePathError)
  })

  it('refuses a write that would pass 1 GiB, including replacement net growth', async () => {
    const dir = await stage()
    const pad = await open(join(dir, 'pad'), 'w')
    await pad.truncate(MAX_WORKSPACE_BYTES)
    await pad.close()
    await expect(writeWorkspaceFile(dir, 'more.txt', Buffer.from('x')))
      .rejects.toBeInstanceOf(CloudWorkspaceQuotaError)

    const handle = await open(join(dir, 'pad'), 'w')
    await handle.truncate(MAX_WORKSPACE_BYTES - 1)
    await handle.close()
    await writeWorkspaceFile(dir, 'pad', Buffer.alloc(MAX_WORKSPACE_BYTES))
    expect(await treeBytes(dir)).toBe(MAX_WORKSPACE_BYTES)
    await expect(writeWorkspaceFile(dir, 'pad', Buffer.alloc(MAX_WORKSPACE_BYTES + 1)))
      .rejects.toMatchObject({ name: 'CloudWorkspaceQuotaError' })
  })

  it('refuses to write through a symlink to a file outside the Workspace', async () => {
    const dir = await stage()
    const victim = join(dir, '..', `outside-${Date.now()}.txt`)
    await writeFile(victim, 'keep')
    const outsideDir = await mkdtemp(join(dir, '..', 'outside-dir-'))
    try {
      await symlink(victim, join(dir, 'link'))
      await expect(writeWorkspaceFile(dir, 'link', Buffer.from('pwn')))
        .rejects.toBeInstanceOf(CloudWorkspacePathError)
      expect(await readFile(victim, 'utf8')).toBe('keep')

      await writeFile(join(outsideDir, 'x.txt'), 'keep')
      await mkdir(join(dir, 'sub'))
      await symlink(outsideDir, join(dir, 'sub', 'out'))
      await expect(writeWorkspaceFile(dir, 'sub/out/x.txt', Buffer.from('pwn')))
        .rejects.toBeInstanceOf(CloudWorkspacePathError)
      expect(await readFile(join(outsideDir, 'x.txt'), 'utf8')).toBe('keep')

      await mkdir(join(dir, 'folder'))
      await expect(writeWorkspaceFile(dir, 'folder', Buffer.from('x'))).rejects.toThrow()
    } finally {
      await rm(victim, { force: true })
      await rm(outsideDir, { recursive: true, force: true })
    }
  })
})

describe('ingestWorkspaceTree', () => {
  it('replaces the tree and refuses a copy past 1 GiB without growing the durable copy', async () => {
    const dir = await stage()
    await writeWorkspaceFile(dir, 'keep.txt', Buffer.from('old'))
    await writeWorkspaceFile(dir, 'gone.txt', Buffer.from('drop'))
    await ingestWorkspaceTree(dir, [
      { relativePath: 'keep.txt', data: Buffer.from('new') },
      { relativePath: 'added.txt', data: Buffer.from('x') },
    ])
    expect(await listWorkspaceFiles(dir)).toEqual(['added.txt', 'keep.txt'])
    expect(Buffer.from(await readWorkspaceFile(dir, 'keep.txt')).toString()).toBe('new')

    const before = await treeBytes(dir)
    await expect(ingestWorkspaceTree(dir, [
      { relativePath: 'huge.bin', data: Buffer.alloc(MAX_WORKSPACE_BYTES + 1) },
    ])).rejects.toBeInstanceOf(CloudWorkspaceQuotaError)
    expect(await treeBytes(dir)).toBe(before)
    expect(await listWorkspaceFiles(dir)).toEqual(['added.txt', 'keep.txt'])
  })
})
