import { mkdir, writeFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CloudWorkspaceQuotaError, MAX_WORKSPACE_BYTES, listWorkspaceFiles, readWorkspaceFile, treeBytes } from '../src/files.ts'
import {
  copyBackWorkspace,
  EXECUTION_WORLD_RUNTIME_DIR,
  hydrateWorkspace,
  type ExecutionWorld,
  type ExecutionWorldEntry,
} from '../src/sync.ts'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

interface FakeFile {
  data: Uint8Array
  symlinkTarget?: string
  type: 'file' | 'dir'
}

class FakeWorld implements ExecutionWorld {
  readonly files = {
    entries: new Map<string, FakeFile>(),
    makeDir: async (path: string): Promise<void> => {
      this.files.entries.set(path, { data: new Uint8Array(), type: 'dir' })
    },
    write: async (path: string, data: string | Uint8Array): Promise<void> => {
      const bytes = typeof data === 'string' ? Buffer.from(data) : data
      this.files.entries.set(path, { data: Uint8Array.from(bytes), type: 'file' })
    },
    read: async (path: string): Promise<Uint8Array> => {
      const entry = this.files.entries.get(path)
      if (entry === undefined || entry.type !== 'file') throw new Error(`missing ${path}`)
      return entry.data
    },
    list: async (path: string): Promise<ExecutionWorldEntry[]> => {
      const prefix = path.endsWith('/') ? path : `${path}/`
      const listed: ExecutionWorldEntry[] = []
      for (const [remote, entry] of this.files.entries) {
        if (remote !== path && !remote.startsWith(prefix)) continue
        if (remote === path) continue
        listed.push({
          path: remote,
          name: remote.slice(remote.lastIndexOf('/') + 1),
          type: entry.type,
          size: entry.data.byteLength,
          ...entry.symlinkTarget === undefined ? {} : { symlinkTarget: entry.symlinkTarget },
        })
      }
      return listed
    },
  }

  constructor() {
    this.files.makeDir = this.files.makeDir.bind(this)
    this.files.write = this.files.write.bind(this)
    this.files.read = this.files.read.bind(this)
    this.files.list = this.files.list.bind(this)
  }
}

describe('hydrateWorkspace and copyBackWorkspace', () => {
  it('hydrates durable files and copies sandbox files back, skipping runtime and symlinks', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-cloud-sync-'))
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'a.ts'), 'hello')
    const world = new FakeWorld()
    await hydrateWorkspace(root, world, '/home/user/workspace')
    expect(Buffer.from(await world.files.read('/home/user/workspace/src/a.ts')).toString()).toBe('hello')

    await world.files.write('/home/user/workspace/src/a.ts', Buffer.from('edited'))
    await world.files.write('/home/user/workspace/new.txt', Buffer.from('added'))
    await world.files.write(`/home/user/workspace/${EXECUTION_WORLD_RUNTIME_DIR}/secret`, Buffer.from('nope'))
    world.files.entries.set('/home/user/workspace/link', {
      data: new Uint8Array(),
      type: 'file',
      symlinkTarget: '/etc/passwd',
    })
    await copyBackWorkspace(root, world, '/home/user/workspace')
    expect(await listWorkspaceFiles(root)).toEqual(['new.txt', 'src/a.ts'])
    expect(Buffer.from(await readWorkspaceFile(root, 'src/a.ts')).toString()).toBe('edited')
  })

  it('refuses copy-back past 1 GiB without growing the durable copy', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-cloud-sync-quota-'))
    await writeFile(join(root, 'keep.txt'), 'keep')
    const world = new FakeWorld()
    await world.files.write('/home/user/workspace/huge.bin', Buffer.alloc(MAX_WORKSPACE_BYTES + 1))
    const before = await treeBytes(root)
    await expect(copyBackWorkspace(root, world, '/home/user/workspace'))
      .rejects.toBeInstanceOf(CloudWorkspaceQuotaError)
    expect(await treeBytes(root)).toBe(before)
    expect(await listWorkspaceFiles(root)).toEqual(['keep.txt'])
  })
})
