import { mkdir, open, symlink, writeFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CloudWorkspacePathError,
  CloudWorkspaceQuotaError,
  MAX_WORKSPACE_BYTES,
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
})
