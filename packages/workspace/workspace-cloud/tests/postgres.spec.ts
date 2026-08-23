import { mkdir, mkdtemp, open, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { accountId } from '@deepseek-ai/dsh-account'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry, { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import CloudWorkspaces, {
  CloudWorkspaceLimitError,
  CloudWorkspaceNotFoundError,
  CloudWorkspaceQuotaError,
  DEFAULT_WORKSPACE_TITLE,
  MAX_WORKSPACE_BYTES,
  MAX_WORKSPACES_PER_ACCOUNT,
} from '../src/index.ts'

let root: string | undefined
let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot(options?: { rootDir?: string; url?: string }): Promise<{
  cloud: CloudWorkspaces
  files: string
  rootDir: string
  url: string
}> {
  const rootDir = options?.rootDir ?? await mkdtemp(join(tmpdir(), 'dsh-cloud-ws-'))
  root = rootDir
  const files = join(rootDir, 'files')
  const url = options?.url ?? 'pglite:'
  ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const storageDomain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', storageDomain)
  ctx.provide('storageDomain', storageDomain)
  ctx.provide('sessionPersistence', { list: () => Promise.resolve([]) } as never)
  await ctx.plugin(WorkspaceRegistry)
  await ctx.plugin(CloudWorkspaces, { url, root: files }).await()
  return { cloud: ctx.cloudWorkspaces, files, rootDir, url }
}

describe('CloudWorkspaces', () => {
  it('fails loud without url/root and before start', async () => {
    expect(() => new CloudWorkspaces(new Context(), { url: '', root: '/tmp' }))
      .toThrow(/url and root/)
    expect(() => new CloudWorkspaces(new Context(), { url: 'pglite:', root: '' }))
      .toThrow(/url and root/)
    const cloud = new CloudWorkspaces(new Context(), { url: 'pglite:', root: '/tmp/cloud' })
    await expect(cloud.createEmpty(accountId('a'))).rejects.toThrow(/not started/)
  })

  it('creates empty owned Workspaces, namespaces files, and caps at three', { timeout: 30_000 }, async () => {
    const { cloud } = await boot()
    const owner = accountId('account-a')
    const other = accountId('account-b')
    const first = await cloud.createEmpty(owner)
    expect(first.title).toBe(DEFAULT_WORKSPACE_TITLE)
    const named = await cloud.createEmpty(owner, '  Notes  ')
    expect(named.title).toBe('Notes')
    expect(cloud.owns(owner, first.id)).toBe(true)
    expect(cloud.owns(other, first.id)).toBe(false)
    expect(cloud.getOwned(other, first.id)).toBeUndefined()
    expect(cloud.listOwned(owner).map(item => item.id)).toEqual([named.id, first.id])
    expect(cloud.listOwned(other)).toEqual([])

    const firstStat = await stat(first.path)
    expect(firstStat.isDirectory()).toBe(true)
    expect(first.path).toContain(owner)

    await cloud.writeFile(owner, first.id, 'readme.txt', Buffer.from('hi'))
    expect(await readFile(join(first.path, 'readme.txt'), 'utf8')).toBe('hi')

    const third = await cloud.createEmpty(owner, 'Third')
    expect(cloud.listOwned(owner)).toHaveLength(MAX_WORKSPACES_PER_ACCOUNT)
    await expect(cloud.createEmpty(owner)).rejects.toBeInstanceOf(CloudWorkspaceLimitError)

    const stranger = await cloud.createEmpty(other)
    expect(cloud.listOwned(other).map(item => item.id)).toEqual([stranger.id])
    await expect(cloud.writeFile(other, first.id, 'x.txt', Buffer.from('no')))
      .rejects.toBeInstanceOf(CloudWorkspaceNotFoundError)
    await expect(cloud.writeFile(owner, WorkspaceId('missing'), 'x.txt', Buffer.from('no')))
      .rejects.toBeInstanceOf(CloudWorkspaceNotFoundError)

    expect(await cloud.deleteOwned(other, first.id)).toBe(false)
    expect(await cloud.deleteOwned(owner, third.id)).toBe(true)
    expect(cloud.owns(owner, third.id)).toBe(false)
    await expect(stat(third.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(cloud.listOwned(owner)).toHaveLength(2)
    await cloud.createEmpty(owner, 'Reuse')
    expect(cloud.listOwned(owner)).toHaveLength(3)
  })

  it('creates concurrently without exceeding the count cap', { timeout: 30_000 }, async () => {
    const { cloud } = await boot()
    const owner = accountId('race')
    const results = await Promise.allSettled([
      cloud.createEmpty(owner, 'A'),
      cloud.createEmpty(owner, 'B'),
      cloud.createEmpty(owner, 'C'),
      cloud.createEmpty(owner, 'D'),
    ])
    const ok = results.filter(result => result.status === 'fulfilled')
    const failed = results.filter(result => result.status === 'rejected')
    expect(ok).toHaveLength(3)
    expect(failed).toHaveLength(1)
    expect((failed[0] as PromiseRejectedResult).reason).toBeInstanceOf(CloudWorkspaceLimitError)
    expect(cloud.listOwned(owner)).toHaveLength(3)
  })

  it('serializes writes so two near-cap files cannot both land', { timeout: 30_000 }, async () => {
    const { cloud } = await boot()
    const owner = accountId('quota')
    const workspace = await cloud.createEmpty(owner)
    const pad = await open(join(workspace.path, 'pad'), 'w')
    await pad.truncate(MAX_WORKSPACE_BYTES - 1)
    await pad.close()
    const results = await Promise.allSettled([
      cloud.writeFile(owner, workspace.id, 'a.txt', Buffer.from('x')),
      cloud.writeFile(owner, workspace.id, 'b.txt', Buffer.from('y')),
    ])
    const ok = results.filter(result => result.status === 'fulfilled')
    const failed = results.filter(result => result.status === 'rejected')
    expect(ok).toHaveLength(1)
    expect(failed).toHaveLength(1)
    expect((failed[0] as PromiseRejectedResult).reason).toBeInstanceOf(CloudWorkspaceQuotaError)
  })

  it('rehydrates PG+files into an empty registry and keeps the count cap', { timeout: 30_000 }, async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'dsh-cloud-restore-'))
    root = rootDir
    const pg = join(rootDir, 'pg')
    await mkdir(pg)
    const url = `pglite:${pg}`
    const first = await boot({ rootDir, url })
    const owner = accountId('restore')
    await first.cloud.createEmpty(owner, 'One')
    await first.cloud.createEmpty(owner, 'Two')
    const kept = await first.cloud.createEmpty(owner, 'Three')
    await first.cloud.setOwnedTitle(owner, kept.id, 'Renamed')
    await ctx?.fiber.dispose()
    ctx = undefined

    const second = await boot({ rootDir, url })
    expect(second.cloud.listOwned(owner).map(item => item.title).sort()).toEqual(['One', 'Renamed', 'Two'])
    await expect(second.cloud.createEmpty(owner)).rejects.toBeInstanceOf(CloudWorkspaceLimitError)
  })
})
