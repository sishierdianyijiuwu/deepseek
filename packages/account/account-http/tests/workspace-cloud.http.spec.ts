/**
 * REAL-composition coverage: two Sign-in cookie jars against Host `/api`.
 * Caps and cross-Account denial are observed as HTTP status and RPC bodies.
 */

import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { Mailer, type MailMessage } from '@deepseek-ai/dsh-mailer'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import PostgresAccounts from '@deepseek-ai/dsh-account-postgres'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import * as AccountHttp from '../src/index.ts'
import { SIGN_IN_COOKIE } from '../src/index.ts'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import CloudWorkspaces, { MAX_WORKSPACE_BYTES } from '@deepseek-ai/dsh-workspace-cloud'
import { createBareRepo, generateSelfSignedTls, listenGitHttps } from '../../../workspace/workspace-cloud/tests/git-http-fixture.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

class CookieJar {
  private readonly values = new Map<string, string>()

  header(): string {
    return [...this.values.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  absorb(response: Response): void {
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(';')[0]
      if (pair === undefined) continue
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      const name = pair.slice(0, eq)
      const value = pair.slice(eq + 1)
      if (value === '') this.values.delete(name)
      else this.values.set(name, value)
    }
  }
}

const mailbox: MailMessage[] = []

class FakeMailer extends Mailer {
  override async send(message: MailMessage): Promise<void> {
    mailbox.push(message)
  }
}

class IsolatedApiProxy extends Service {
  static inject = ['sessions', 'agents', 'userQuestions', 'storage']

  constructor(ctx: Context) {
    super(ctx, 'apiProxy')
    ctx.storage.backend.register('memory', new MemoryStorageBackend())
    const storageDomain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', storageDomain)
    ctx.provide('storageDomain', storageDomain)
    ctx.provide('sessionPersistence', { list: () => Promise.resolve([]) } as never)
    ctx.agents.setFactory({
      createAgent: async (ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> => {
        const session = ctx.sessions.create(options.sessionId, {
          ...options.seed === undefined ? {} : { seed: [...options.seed] },
          ...options.meta === undefined ? {} : { meta: options.meta },
        })
        const agent = {} as Agent
        const agentCtx = ownerCtx.extend({ agent })
        Object.assign(agent, {
          id: session.id,
          session,
          status: 'idle',
          ctx: agentCtx,
          inbox: { nextTurn: [], nextStep: [] },
          cancel: () => undefined,
        })
        await options.setup?.(agentCtx)
        ctx.agents.register(agent)
        return { agent, dispose: () => Promise.resolve() }
      },
      resume: () => Promise.reject(new Error('http workspace tests create live sessions')),
    })
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: root ?? '/tmp',
    })
    Object.assign(this, api)
  }
}

interface Harness {
  port: number
}

async function boot(): Promise<Harness> {
  mailbox.length = 0
  root = await mkdtemp(join(tmpdir(), 'dsh-cloud-http-'))
  const files = join(root, 'workspaces')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    "- name: '@deepseek-ai/dsh-mailer'",
    "- name: '@deepseek-ai/dsh-account-postgres'",
    '  config:',
    "    url: 'pglite:'",
    "    publicBaseUrl: 'http://127.0.0.1'",
    "- name: '@deepseek-ai/dsh-account-http'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-user-questions'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-storage'",
    "- name: 'test-api-proxy'",
    "- name: '@deepseek-ai/dsh-workspace'",
    "- name: '@deepseek-ai/dsh-workspace-cloud'",
    '  config:',
    "    url: 'pglite:'",
    `    root: ${JSON.stringify(files)}`,
    "- name: '@deepseek-ai/dsh-client-connection'",
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    ['@deepseek-ai/dsh-mailer', FakeMailer],
    ['@deepseek-ai/dsh-account-postgres', PostgresAccounts],
    ['@deepseek-ai/dsh-account-http', AccountHttp],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-user-questions', UserQuestionService],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-storage', Storage],
    ['test-api-proxy', IsolatedApiProxy],
    ['@deepseek-ai/dsh-workspace', WorkspaceRegistry],
    ['@deepseek-ai/dsh-workspace-cloud', CloudWorkspaces],
    ['@deepseek-ai/dsh-client-connection', Connection],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return { port: context.webServer.port }
}

async function raw(
  harness: Harness,
  jar: CookieJar | undefined,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  const cookie = jar?.header() ?? ''
  if (cookie !== '' && !headers.has('cookie')) headers.set('cookie', cookie)
  const response = await fetch(`http://127.0.0.1:${String(harness.port)}${path}`, {
    ...init,
    headers,
    redirect: 'manual',
  })
  jar?.absorb(response)
  return response
}

async function rpc(
  harness: Harness,
  jar: CookieJar | undefined,
  method: string,
  payload: unknown,
): Promise<{ status: number; body: unknown }> {
  const response = await raw(harness, jar, `/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `rpc-${method}`, method, payload }),
  })
  const text = await response.text()
  let body: unknown = text
  if (text !== '') {
    try { body = JSON.parse(text) as unknown } catch { body = text }
  }
  return { status: response.status, body }
}

function tokenFromMailbox(): string {
  const last = mailbox.at(-1)
  expect(last).toBeDefined()
  const match = /\/verify\?token=([0-9a-f]+)/.exec(last?.text ?? '')
  expect(match?.[1]).toBeDefined()
  return match![1]!
}

async function signInAccount(
  harness: Harness,
  email: string,
  password: string,
): Promise<CookieJar> {
  const jar = new CookieJar()
  const registered = await raw(harness, jar, '/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  expect(registered.status).toBe(200)
  const verify = await raw(harness, jar, `/verify?token=${tokenFromMailbox()}`)
  expect(verify.status).toBe(302)
  const signedIn = await raw(harness, jar, '/auth/sign-in', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  expect(signedIn.status).toBe(200)
  expect(jar.header()).toContain(SIGN_IN_COOKIE)
  return jar
}

function rpcError(body: unknown): string | undefined {
  return (body as { result?: { ok?: boolean; error?: { code: string } } }).result?.error?.code
}

function workspaceItems(body: unknown): { workspaceId: string; path: string; title: string }[] {
  const result = (body as {
    result?: { ok?: boolean; value?: { items?: { workspaceId: string; path: string; title: string }[] } }
  }).result
  expect(result?.ok).toBe(true)
  return result?.value?.items ?? []
}

function archivedSessionIds(body: unknown): string[] {
  return (body as { result?: { value?: { archivedSessionIds?: string[] } } }).result?.value?.archivedSessionIds ?? []
}

describe('Cloud Workspaces over HTTP', () => {
  it('creates empty owned Workspaces, refuses a fourth and 1 GiB, and denies cross-Account access', {
    timeout: 60_000,
  }, async () => {
    const harness = await boot()
    const password = 'correct-horse'
    const jarA = await signInAccount(harness, 'a@example.com', password)
    const jarB = await signInAccount(harness, 'b@example.com', password)

    const missingSession = await rpc(harness, jarA, 'session.create', {})
    expect(missingSession.status).toBe(200)
    expect(rpcError(missingSession.body)).toBe('workspace-required')

    const created = await rpc(harness, jarA, 'workspace.create', { title: 'Alpha' })
    expect(created.status).toBe(200)
    const createdBody = created.body as {
      result?: { ok?: boolean; value?: { workspace: { workspaceId: string; path: string }; created: boolean } }
    }
    expect(createdBody.result?.ok).toBe(true)
    expect(createdBody.result?.value?.created).toBe(true)
    const workspaceId = createdBody.result?.value?.workspace.workspaceId
    const workspacePath = createdBody.result?.value?.workspace.path
    expect(workspaceId).toEqual(expect.any(String))
    expect(workspacePath).toContain(join('workspaces'))

    const listedAResponse = await rpc(harness, jarA, 'workspace.list', {})
    expect(listedAResponse.status, JSON.stringify(listedAResponse.body)).toBe(200)
    const listedA = workspaceItems(listedAResponse.body)
    expect(listedA.map(item => item.workspaceId)).toEqual([workspaceId])
    const listedAgain = await rpc(harness, jarA, 'workspace.list', {})
    expect(
      (listedAgain.body as { result?: { value?: { emptyCreate?: boolean } } }).result?.value?.emptyCreate,
    ).toBe(true)
    expect(workspaceItems((await rpc(harness, jarB, 'workspace.list', {})).body)).toEqual([])

    expect(rpcError((await rpc(harness, jarB, 'workspace.rename', {
      workspaceId, title: 'Stolen',
    })).body)).toBe('workspace-not-found')
    expect(rpcError((await rpc(harness, jarB, 'workspace.delete', { workspaceId })).body))
      .toBe('workspace-not-found')
    expect(rpcError((await rpc(harness, jarB, 'workspace.write', {
      workspaceId, path: 'x.txt', data: 'no',
    })).body)).toBe('workspace-not-found')
    expect(rpcError((await rpc(harness, jarB, 'session.create', { workspaceId })).body))
      .toBe('workspace-not-found')
    const browse = await rpc(harness, jarB, 'host.listDirectory', { path: workspacePath })
    expect(rpcError(browse.body)).toBe('directory-picker-unavailable')
    expect(
      (browse.body as { result?: { error?: { details?: { capability?: string } } } }).result?.error?.details
        ?.capability,
    ).toBe('cloud')
    expect(rpcError((await rpc(harness, jarA, 'host.pickDirectory', {})).body))
      .toBe('directory-picker-unavailable')

    const sessionA = await rpc(harness, jarA, 'session.create', { workspaceId })
    expect(sessionA.status).toBe(200)
    expect((sessionA.body as { result?: { ok?: boolean } }).result?.ok).toBe(true)
    const sessionId = (sessionA.body as { result?: { value?: { sessionId?: string } } }).result?.value?.sessionId
    expect(sessionId).toEqual(expect.any(String))
    expect((await rpc(harness, jarA, 'workspace.archiveSession', { sessionId })).status).toBe(200)
    expect(archivedSessionIds((await rpc(harness, jarA, 'workspace.list', {})).body)).toEqual([sessionId])
    expect(archivedSessionIds((await rpc(harness, jarB, 'workspace.list', {})).body)).toEqual([])
    expect(rpcError((await rpc(harness, jarB, 'workspace.archiveSession', { sessionId })).body))
      .toBe('session-not-found')

    await rpc(harness, jarA, 'workspace.create', { title: 'Two' })
    await rpc(harness, jarA, 'workspace.create', { title: 'Three' })
    expect(rpcError((await rpc(harness, jarA, 'workspace.create', { title: 'Four' })).body))
      .toBe('workspace-limit')

    expect(rpcError((await rpc(harness, jarA, 'workspace.write', {
      workspaceId, path: '../escape.txt', data: 'x',
    })).body)).toBe('workspace-invalid-path')

    const note = await rpc(harness, jarA, 'workspace.write', {
      workspaceId, path: 'note.txt', data: 'ok',
    })
    expect((note.body as { result?: { ok?: boolean } }).result?.ok).toBe(true)
    const { readFile } = await import('node:fs/promises')
    expect(await readFile(join(workspacePath!, 'note.txt'), 'utf8')).toBe('ok')

    const pad = await open(join(workspacePath!, 'pad'), 'w')
    await pad.truncate(MAX_WORKSPACE_BYTES)
    await pad.close()
    expect(rpcError((await rpc(harness, jarA, 'workspace.write', {
      workspaceId, path: 'overflow.txt', data: 'x',
    })).body)).toBe('workspace-quota-exceeded')

    const laptop = await rpc(harness, jarA, 'workspace.create', { path: '/tmp/not-cloud' })
    expect(rpcError(laptop.body)).toBe('workspace-invalid-path')
  })

  it('imports a local public HTTPS git fixture, refuses private remotes, and enforces caps', {
    timeout: 120_000,
  }, async () => {
    const harness = await boot()
    const password = 'correct-horse'
    const jarA = await signInAccount(harness, 'import-a@example.com', password)
    const jarB = await signInAccount(harness, 'import-b@example.com', password)

    const tlsDir = join(root!, 'git-tls')
    const publicRoot = join(root!, 'git-public')
    const privateRoot = join(root!, 'git-private')
    await mkdir(tlsDir)
    await mkdir(publicRoot)
    await mkdir(privateRoot)
    const tls = await generateSelfSignedTls(tlsDir)
    await createBareRepo(publicRoot, 'notes', { 'README.md': 'from git\n' })
    await createBareRepo(publicRoot, 'huge', { pad: { truncate: MAX_WORKSPACE_BYTES } })
    await createBareRepo(privateRoot, 'secret', { 'secret.txt': 'nope\n' })
    const pub = await listenGitHttps({ root: publicRoot, key: tls.key, cert: tls.cert })
    const priv = await listenGitHttps({
      root: privateRoot, key: tls.key, cert: tls.cert,
      basicAuth: { user: 'owner', pass: 'secret' },
    })
    try {
      const imported = await rpc(harness, jarA, 'workspace.import', { gitUrl: pub.url('notes') })
      expect(imported.status).toBe(200)
      const importedBody = imported.body as {
        result?: { ok?: boolean; value?: { workspace: { workspaceId: string; path: string; title: string }; created: boolean } }
      }
      expect(importedBody.result?.ok).toBe(true)
      expect(importedBody.result?.value?.created).toBe(true)
      const workspaceId = importedBody.result?.value?.workspace.workspaceId
      const workspacePath = importedBody.result?.value?.workspace.path
      expect(importedBody.result?.value?.workspace.title).toBe('notes')
      expect(workspaceId).toEqual(expect.any(String))
      expect(workspacePath).toContain(join('workspaces'))
      const { readFile } = await import('node:fs/promises')
      expect(await readFile(join(workspacePath!, 'README.md'), 'utf8')).toBe('from git\n')

      expect(workspaceItems((await rpc(harness, jarB, 'workspace.list', {})).body)).toEqual([])
      expect(rpcError((await rpc(harness, jarB, 'workspace.write', {
        workspaceId, path: 'stolen.txt', data: 'no',
      })).body)).toBe('workspace-not-found')
      expect(rpcError((await rpc(harness, jarB, 'workspace.delete', { workspaceId })).body))
        .toBe('workspace-not-found')
      expect(rpcError((await rpc(harness, jarB, 'session.create', { workspaceId })).body))
        .toBe('workspace-not-found')

      expect(rpcError((await rpc(harness, jarA, 'workspace.import', {
        gitUrl: 'https://user:token@example.com/acme/notes.git',
      })).body)).toBe('workspace-import-refused')
      expect(rpcError((await rpc(harness, jarA, 'workspace.import', {
        gitUrl: 'git@example.com:acme/notes.git',
      })).body)).toBe('workspace-import-refused')
      expect(rpcError((await rpc(harness, jarA, 'workspace.import', {
        gitUrl: priv.url('secret'),
      })).body)).toBe('workspace-import-refused')

      await rpc(harness, jarA, 'workspace.create', { title: 'Two' })
      await rpc(harness, jarA, 'workspace.create', { title: 'Three' })
      expect(rpcError((await rpc(harness, jarA, 'workspace.import', { gitUrl: pub.url('notes') })).body))
        .toBe('workspace-limit')

      expect(rpcError((await rpc(harness, jarB, 'workspace.import', { gitUrl: pub.url('huge') })).body))
        .toBe('workspace-quota-exceeded')
      expect(workspaceItems((await rpc(harness, jarB, 'workspace.list', {})).body)).toEqual([])
    } finally {
      await pub.close()
      await priv.close()
    }
  })
})
