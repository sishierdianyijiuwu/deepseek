import { lstat, mkdir, mkdtemp, open, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
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
  CloudWorkspaceImportError,
  CloudWorkspaceImportUrlError,
  CloudWorkspaceLimitError,
  CloudWorkspaceNotFoundError,
  CloudWorkspacePathError,
  CloudWorkspaceQuotaError,
  DEFAULT_WORKSPACE_TITLE,
  MAX_WORKSPACE_BYTES,
  MAX_WORKSPACES_PER_ACCOUNT,
  type ExecutionWorld,
  type ExecutionWorldEntry,
} from '../src/index.ts'
import { createBareRepo, generateSelfSignedTls, listenGitHttps } from './git-http-fixture.ts'

let root: string | undefined
let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot(options?: { rootDir?: string; url?: string; importTimeoutMs?: number }): Promise<{
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
  await ctx.plugin(CloudWorkspaces, {
    url, root: files, importTlsInsecure: true,
    ...options?.importTimeoutMs === undefined ? {} : { importTimeoutMs: options.importTimeoutMs },
  }).await()
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
    expect(await cloud.listFiles(owner, first.id)).toEqual(['readme.txt'])
    expect(Buffer.from(await cloud.readFile(owner, first.id, 'readme.txt')).toString()).toBe('hi')
    await expect(cloud.readFile(other, first.id, 'readme.txt')).rejects.toBeInstanceOf(CloudWorkspaceNotFoundError)

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

  it('hydrates into an execution world and copies back under the cap', { timeout: 30_000 }, async () => {
    const { cloud } = await boot()
    const owner = accountId('hydrate')
    const workspace = await cloud.createEmpty(owner)
    await cloud.writeFile(owner, workspace.id, 'a.txt', Buffer.from('src'))
    const remote = new Map<string, { data: Uint8Array; type: 'file' | 'dir'; symlinkTarget?: string }>()
    const world: ExecutionWorld = {
      files: {
        makeDir: async (path: string) => { remote.set(path, { data: new Uint8Array(), type: 'dir' }) },
        write: async (path: string, data: string | Uint8Array) => {
          remote.set(path, {
            data: Uint8Array.from(typeof data === 'string' ? Buffer.from(data) : data),
            type: 'file',
          })
        },
        read: async (path: string) => {
          const entry = remote.get(path)
          if (entry === undefined) throw new Error('missing')
          return entry.data
        },
        list: async (path: string) => {
          const prefix = `${path}/`
          const listed: ExecutionWorldEntry[] = []
          for (const [remotePath, entry] of remote) {
            if (remotePath === path || !remotePath.startsWith(prefix)) continue
            listed.push({
              path: remotePath,
              name: remotePath.slice(remotePath.lastIndexOf('/') + 1),
              type: entry.type,
              ...entry.symlinkTarget === undefined ? {} : { symlinkTarget: entry.symlinkTarget },
            })
          }
          return listed
        },
      },
    }
    await cloud.hydrateInto(owner, workspace.id, world, '/home/user/workspace')
    expect(Buffer.from(remote.get('/home/user/workspace/a.txt')!.data).toString()).toBe('src')
    await world.files.write('/home/user/workspace/a.txt', Buffer.from('dst'))
    await world.files.write('/home/user/workspace/b.txt', Buffer.from('b'))
    await cloud.copyBackFrom(owner, workspace.id, world, '/home/user/workspace')
    expect(await cloud.listFiles(owner, workspace.id)).toEqual(['a.txt', 'b.txt'])
    await expect(cloud.hydrateInto(owner, WorkspaceId('missing'), world, '/w'))
      .rejects.toBeInstanceOf(CloudWorkspaceNotFoundError)
    await expect(cloud.copyBackFrom(owner, WorkspaceId('missing'), world, '/w'))
      .rejects.toBeInstanceOf(CloudWorkspaceNotFoundError)
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

  it('waits in-flight writes before delete so the tree stays gone', { timeout: 30_000 }, async () => {
    const { cloud } = await boot()
    const owner = accountId('delete-race')
    const workspace = await cloud.createEmpty(owner)
    const path = workspace.path
    const results = await Promise.allSettled([
      cloud.writeFile(owner, workspace.id, 'a.txt', Buffer.from('x')),
      cloud.writeFile(owner, workspace.id, 'b.txt', Buffer.from('y')),
      cloud.deleteOwned(owner, workspace.id),
    ])
    const deleted = results[2]
    expect(deleted.status).toBe('fulfilled')
    if (deleted.status === 'fulfilled') expect(deleted.value).toBe(true)
    for (const result of results.slice(0, 2)) {
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(CloudWorkspaceNotFoundError)
      }
    }
    expect(cloud.owns(owner, workspace.id)).toBe(false)
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(cloud.writeFile(owner, workspace.id, 'after.txt', Buffer.from('z')))
      .rejects.toBeInstanceOf(CloudWorkspaceNotFoundError)
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
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

  it('imports a local public HTTPS git fixture into an owned slot and refuses private remotes', {
    timeout: 60_000,
  }, async () => {
    const { cloud, rootDir } = await boot()
    const tlsDir = join(rootDir, 'tls')
    await mkdir(tlsDir)
    const tls = await generateSelfSignedTls(tlsDir)
    const publicRoot = join(rootDir, 'git-public')
    await mkdir(publicRoot)
    await createBareRepo(publicRoot, 'notes', { 'README.md': 'hello import\n' })
    const pub = await listenGitHttps({ root: publicRoot, key: tls.key, cert: tls.cert })
    const privateRoot = join(rootDir, 'git-private')
    await mkdir(privateRoot)
    await createBareRepo(privateRoot, 'secret', { 'secret.txt': 'nope\n' })
    const priv = await listenGitHttps({
      root: privateRoot, key: tls.key, cert: tls.cert,
      basicAuth: { user: 'owner', pass: 'secret' },
    })
    try {
      const owner = accountId('importer')
      const other = accountId('stranger')
      const imported = await cloud.importPublicGit(owner, pub.url('notes'), '  ')
      expect(imported.title).toBe('notes')
      expect(imported.path).toContain(owner)
      expect(await readFile(join(imported.path, 'README.md'), 'utf8')).toBe('hello import\n')
      expect(cloud.owns(owner, imported.id)).toBe(true)
      expect(cloud.owns(other, imported.id)).toBe(false)
      expect(cloud.listOwned(other)).toEqual([])

      await expect(cloud.importPublicGit(owner, 'https://user:token@example.com/acme/notes.git'))
        .rejects.toMatchObject({ name: 'CloudWorkspaceImportUrlError' })
      try {
        await cloud.importPublicGit(owner, 'https://user:token@example.com/acme/notes.git')
      } catch (error: unknown) {
        expect(String(error)).not.toContain('token')
        expect((error as CloudWorkspaceImportUrlError).gitUrl).not.toContain('token')
      }
      await expect(cloud.importPublicGit(owner, 'http://127.0.0.1/notes.git'))
        .rejects.toBeInstanceOf(CloudWorkspaceImportUrlError)
      await expect(cloud.importPublicGit(owner, 'git@example.com:acme/notes.git'))
        .rejects.toBeInstanceOf(CloudWorkspaceImportUrlError)
      await expect(cloud.importPublicGit(owner, priv.url('secret')))
        .rejects.toBeInstanceOf(CloudWorkspaceImportError)
      expect(cloud.listOwned(owner)).toHaveLength(1)
    } finally {
      await pub.close()
      await priv.close()
    }
  })

  it('refuses Import that would take a fourth slot or exceed 1 GiB', {
    timeout: 120_000,
  }, async () => {
    const { cloud, rootDir } = await boot()
    const tlsDir = join(rootDir, 'tls-cap')
    await mkdir(tlsDir)
    const tls = await generateSelfSignedTls(tlsDir)
    const gitRoot = join(rootDir, 'git-cap')
    await mkdir(gitRoot)
    await createBareRepo(gitRoot, 'tiny', { 'ok.txt': 'ok\n' })
    await createBareRepo(gitRoot, 'huge', { pad: { truncate: MAX_WORKSPACE_BYTES } })
    const server = await listenGitHttps({ root: gitRoot, key: tls.key, cert: tls.cert })
    try {
      const owner = accountId('capped')
      await cloud.createEmpty(owner, 'One')
      await cloud.createEmpty(owner, 'Two')
      await cloud.importPublicGit(owner, server.url('tiny'), 'Three')
      expect(cloud.listOwned(owner)).toHaveLength(MAX_WORKSPACES_PER_ACCOUNT)
      await expect(cloud.importPublicGit(owner, server.url('tiny')))
        .rejects.toBeInstanceOf(CloudWorkspaceLimitError)
      expect(cloud.listOwned(owner)).toHaveLength(3)

      const other = accountId('quota-import')
      await expect(cloud.importPublicGit(other, server.url('huge')))
        .rejects.toBeInstanceOf(CloudWorkspaceQuotaError)
      expect(cloud.listOwned(other)).toEqual([])
    } finally {
      await server.close()
    }
  })

  it('aborts a hung clone without listing a Workspace or keeping a slot', {
    timeout: 30_000,
  }, async () => {
    const { cloud, rootDir } = await boot({ importTimeoutMs: 400 })
    const tlsDir = join(rootDir, 'tls-hang')
    await mkdir(tlsDir)
    const tls = await generateSelfSignedTls(tlsDir)
    const gitRoot = join(rootDir, 'git-hang')
    await mkdir(gitRoot)
    await createBareRepo(gitRoot, 'notes', { 'README.md': 'slow\n' })
    const hang = await listenGitHttps({ root: gitRoot, key: tls.key, cert: tls.cert, hang: true })
    try {
      const owner = accountId('hung')
      const abort = new AbortController()
      const pending = cloud.importPublicGit(owner, hang.url('notes'), undefined, abort.signal)
      await new Promise((resolve) => { setTimeout(resolve, 150) })
      expect(cloud.listOwned(owner)).toEqual([])
      abort.abort()
      await expect(pending).rejects.toMatchObject({ name: 'CloudWorkspaceImportError', reason: 'cancelled' })
      expect(cloud.listOwned(owner)).toEqual([])
      await expect(cloud.importPublicGit(owner, hang.url('notes')))
        .rejects.toMatchObject({ name: 'CloudWorkspaceImportError', reason: 'timed-out' })
      expect(cloud.listOwned(owner)).toEqual([])
      await cloud.createEmpty(owner, 'One')
      await cloud.createEmpty(owner, 'Two')
      await cloud.createEmpty(owner, 'Three')
      await expect(cloud.createEmpty(owner)).rejects.toBeInstanceOf(CloudWorkspaceLimitError)
    } finally {
      await hang.close()
    }
  })

  it('ignores parent GIT_CONFIG_GLOBAL credential.helper and insteadOf for a private remote', {
    timeout: 30_000,
  }, async () => {
    const { cloud, rootDir } = await boot()
    const tlsDir = join(rootDir, 'tls-cred')
    await mkdir(tlsDir)
    const tls = await generateSelfSignedTls(tlsDir)
    const privateRoot = join(rootDir, 'git-cred')
    await mkdir(privateRoot)
    await createBareRepo(privateRoot, 'secret', { 'secret.txt': 'nope\n' })
    const priv = await listenGitHttps({
      root: privateRoot, key: tls.key, cert: tls.cert,
      basicAuth: { user: 'owner', pass: 'secret' },
    })
    const remote = priv.url('secret')
    const ambient = join(rootDir, 'ambient.gitconfig')
    await writeFile(ambient, `[credential]
	helper = store
[url "${remote.replace('https://', 'https://owner:secret@')}"]
	insteadOf = ${remote}
`)
    const previous = process.env['GIT_CONFIG_GLOBAL']
    process.env['GIT_CONFIG_GLOBAL'] = ambient
    process.env['GIT_TERMINAL_PROMPT'] = '1'
    try {
      await expect(cloud.importPublicGit(accountId('cred'), remote))
        .rejects.toBeInstanceOf(CloudWorkspaceImportError)
      expect(cloud.listOwned(accountId('cred'))).toEqual([])
    } finally {
      if (previous === undefined) delete process.env['GIT_CONFIG_GLOBAL']
      else process.env['GIT_CONFIG_GLOBAL'] = previous
      await priv.close()
    }
  })

  it('does not follow a cloned or planted symlink into another Account tree', {
    timeout: 30_000,
  }, async () => {
    const { cloud, rootDir } = await boot()
    const tlsDir = join(rootDir, 'tls-link')
    await mkdir(tlsDir)
    const tls = await generateSelfSignedTls(tlsDir)
    const gitRoot = join(rootDir, 'git-link')
    await mkdir(gitRoot)
    await createBareRepo(gitRoot, 'notes', {
      'README.md': 'ok\n',
      escape: { symlink: '../../victim/secret.txt' },
    })
    const pub = await listenGitHttps({ root: gitRoot, key: tls.key, cert: tls.cert })
    try {
      const owner = accountId('linker')
      const victim = accountId('victim')
      const other = await cloud.createEmpty(victim, 'Victim')
      await cloud.writeFile(victim, other.id, 'secret.txt', Buffer.from('keep'))
      const imported = await cloud.importPublicGit(owner, pub.url('notes'))
      expect((await lstat(join(imported.path, 'escape'))).isSymbolicLink()).toBe(false)
      const planted = join(imported.path, 'planted')
      await symlink(join(other.path, 'secret.txt'), planted)
      await expect(cloud.writeFile(owner, imported.id, 'planted', Buffer.from('pwn')))
        .rejects.toBeInstanceOf(CloudWorkspacePathError)
      expect(await readFile(join(other.path, 'secret.txt'), 'utf8')).toBe('keep')
    } finally {
      await pub.close()
    }
  })
})
