/**
 * REAL-composition coverage: Sign-in cookie jars against Host `/api` with the
 * E2B SDK faked. Hydrate, copy-back, the 1 GiB cap, and one Executing Session
 * are observed as HTTP status and RPC bodies.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
import CloudWorkspaces, { MAX_WORKSPACE_BYTES } from '@deepseek-ai/dsh-workspace-cloud'
import { ExecutingSessionBusyError } from '@deepseek-ai/dsh-e2b'
import type { AccountId } from '@deepseek-ai/dsh-account'
import type { SessionId } from '@deepseek-ai/dsh-session'
import * as AccountHttp from '../src/index.ts'
import { SIGN_IN_COOKIE } from '../src/index.ts'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

interface RemoteFile {
  data: Uint8Array
  type: 'file' | 'dir'
  symlinkTarget?: string
}

function createRemoteWorld(): {
  world: {
    files: {
      makeDir: (path: string) => Promise<void>
      write: (path: string, data: string | Uint8Array) => Promise<void>
      read: (path: string) => Promise<Uint8Array>
      list: (path: string) => Promise<Array<{ path: string; name: string; type: string; symlinkTarget?: string }>>
    }
  }
  remote: Map<string, RemoteFile>
  created: number
} {
  const remote = new Map<string, RemoteFile>()
  const world = {
    files: {
      makeDir: async (path: string): Promise<void> => {
        remote.set(path, { data: new Uint8Array(), type: 'dir' })
      },
      write: async (path: string, data: string | Uint8Array): Promise<void> => {
        const bytes = typeof data === 'string' ? Buffer.from(data) : data
        remote.set(path, { data: Uint8Array.from(bytes), type: 'file' })
      },
      read: async (path: string): Promise<Uint8Array> => {
        const entry = remote.get(path)
        if (entry === undefined || entry.type !== 'file') throw new Error(`missing ${path}`)
        return entry.data
      },
      list: async (path: string) => {
        const prefix = path.endsWith('/') ? path : `${path}/`
        const listed: Array<{ path: string; name: string; type: string; symlinkTarget?: string }> = []
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
  return { world, remote, created: 0 }
}

let root: string | undefined
let context: Context | undefined
const idleGates = new Map<string, PromiseWithResolvers<undefined>>()
const mailbox: MailMessage[] = []
let currentWorld: ReturnType<typeof createRemoteWorld> | undefined

afterEach(async () => {
  for (const gate of idleGates.values()) gate.resolve(undefined)
  await new Promise(resolve => setTimeout(resolve, 100))
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  idleGates.clear()
  mailbox.length = 0
  currentWorld = undefined
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

class FakeMailer extends Mailer {
  override async send(message: MailMessage): Promise<void> {
    mailbox.push(message)
  }
}

class FakeCredentials extends Service {
  constructor(ctx: Context) {
    super(ctx, 'credentials')
  }

  hasStoredSecret(): Promise<boolean> {
    return Promise.resolve(true)
  }
}

class FakeE2B extends Service {
  readonly perExecutingSession = true
  readonly cwd = '/home/user/workspace'
  private slot: { accountId: AccountId; sessionId: SessionId } | undefined

  constructor(ctx: Context) {
    super(ctx, 'e2b')
    currentWorld = createRemoteWorld()
  }

  async startExecutingSession(accountId: AccountId, sessionId: SessionId) {
    if (this.slot !== undefined && this.slot.sessionId !== sessionId) {
      throw new ExecutingSessionBusyError(this.slot.sessionId)
    }
    this.slot = { accountId, sessionId }
    const world = currentWorld
    if (world === undefined) throw new Error('fake E2B world missing')
    world.created += 1
    return world.world
  }

  async stopExecutingSession(accountId: AccountId, sessionId: SessionId): Promise<void> {
    if (this.slot?.accountId === accountId && this.slot.sessionId === sessionId) this.slot = undefined
  }

  executingSessionId(accountId: AccountId): SessionId | undefined {
    return this.slot?.accountId === accountId ? this.slot.sessionId : undefined
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
        const idle = Promise.withResolvers<undefined>()
        idleGates.set(session.id, idle)
        const live = {
          status: 'idle' as 'idle' | 'running',
        }
        Object.assign(agent, {
          id: session.id,
          session,
          get status() { return live.status },
          ctx: agentCtx,
          inbox: { nextTurn: [], nextStep: [] },
          cancel: () => undefined,
          followup: () => { live.status = 'running' },
          steer: () => { live.status = 'running' },
          whenIdle: () => idle.promise.then(() => { live.status = 'idle' }),
        })
        await options.setup?.(agentCtx)
        ctx.agents.register(agent)
        return { agent, dispose: () => Promise.resolve() }
      },
      resume: () => Promise.reject(new Error('http e2b tests create live sessions')),
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
  root = await mkdtemp(join(tmpdir(), 'dsh-e2b-http-'))
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
    "- name: '@deepseek-ai/dsh-credentials'",
    "- name: '@deepseek-ai/dsh-e2b'",
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
    ['@deepseek-ai/dsh-credentials', FakeCredentials],
    ['@deepseek-ai/dsh-e2b', FakeE2B],
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

describe('E2B Executing Session over HTTP', () => {
  it('hydrates, copy-backs, refuses a second Executing Session, and keeps extra-tab reads', {
    timeout: 60_000,
  }, async () => {
    const harness = await boot()
    const password = 'correct-horse'
    const jarA = await signInAccount(harness, 'a@example.com', password)
    const jarTab = await signInAccount(harness, 'a@example.com', password)
    const jarB = await signInAccount(harness, 'b@example.com', password)

    const workspaceA = await rpc(harness, jarA, 'workspace.create', { title: 'Alpha' })
    const workspaceId = (workspaceA.body as {
      result?: { value?: { workspace?: { workspaceId?: string } } }
    }).result?.value?.workspace?.workspaceId
    expect(workspaceId).toEqual(expect.any(String))
    expect((await rpc(harness, jarA, 'workspace.write', {
      workspaceId, path: 'note.txt', data: 'hello',
    })).status).toBe(200)

    const sessionA = await rpc(harness, jarA, 'session.create', { workspaceId })
    const sessionId = (sessionA.body as { result?: { value?: { sessionId?: string } } }).result?.value?.sessionId
    expect(sessionId).toEqual(expect.any(String))

    const prompt = await rpc(harness, jarA, 'session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'run' }],
    })
    expect(prompt.status).toBe(200)
    expect((prompt.body as { result?: { ok?: boolean } }).result?.ok).toBe(true)
    expect(currentWorld?.created).toBeGreaterThan(0)
    const hydrated = currentWorld?.remote.get('/home/user/workspace/note.txt')
    expect(hydrated).toBeDefined()
    expect(Buffer.from(hydrated?.data ?? new Uint8Array()).toString()).toBe('hello')

    const workspaceB = await rpc(harness, jarA, 'workspace.create', { title: 'Beta' })
    const workspaceBId = (workspaceB.body as {
      result?: { value?: { workspace?: { workspaceId?: string } } }
    }).result?.value?.workspace?.workspaceId
    const sessionB = await rpc(harness, jarA, 'session.create', { workspaceId: workspaceBId })
    const sessionBId = (sessionB.body as { result?: { value?: { sessionId?: string } } }).result?.value?.sessionId
    const busy = await rpc(harness, jarA, 'session.prompt', {
      sessionId: sessionBId,
      mode: 'queue',
      content: [{ type: 'text', text: 'other' }],
    })
    expect(rpcError(busy.body)).toBe('executing-session-busy')

    const historyTab = await rpc(harness, jarTab, 'session.history', { sessionId })
    expect(historyTab.status).toBe(200)
    expect((historyTab.body as { result?: { ok?: boolean } }).result?.ok).toBe(true)

    const otherAccount = await rpc(harness, jarB, 'session.history', { sessionId })
    expect(rpcError(otherAccount.body)).toBe('session-not-found')

    await currentWorld?.world.files.write('/home/user/workspace/note.txt', Buffer.from('edited'))
    await currentWorld?.world.files.write('/home/user/workspace/out.txt', Buffer.from('new'))
    if (sessionId !== undefined) idleGates.get(sessionId)?.resolve(undefined)
    await expect.poll(async () => {
      const listed = await rpc(harness, jarA, 'workspace.listFiles', { workspaceId })
      return (listed.body as { result?: { value?: { paths?: string[] } } }).result?.value?.paths
    }).toEqual(['note.txt', 'out.txt'])

    const promptB = await rpc(harness, jarA, 'session.prompt', {
      sessionId: sessionBId,
      mode: 'queue',
      content: [{ type: 'text', text: 'now' }],
    })
    expect((promptB.body as { result?: { ok?: boolean } }).result?.ok).toBe(true)
    if (sessionBId !== undefined) idleGates.get(sessionBId)?.resolve(undefined)
  })

  it('refuses copy-back past 1 GiB without growing the durable copy', {
    timeout: 60_000,
  }, async () => {
    const harness = await boot()
    const jar = await signInAccount(harness, 'cap@example.com', 'correct-horse')
    const created = await rpc(harness, jar, 'workspace.create', { title: 'Cap' })
    const workspaceId = (created.body as {
      result?: { value?: { workspace?: { workspaceId?: string } } }
    }).result?.value?.workspace?.workspaceId
    await rpc(harness, jar, 'workspace.write', { workspaceId, path: 'keep.txt', data: 'keep' })
    const session = await rpc(harness, jar, 'session.create', { workspaceId })
    const sessionId = (session.body as { result?: { value?: { sessionId?: string } } }).result?.value?.sessionId
    expect((await rpc(harness, jar, 'session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'go' }],
    })).status).toBe(200)
    await currentWorld?.world.files.write(
      '/home/user/workspace/huge.bin',
      Buffer.alloc(MAX_WORKSPACE_BYTES + 1),
    )
    if (sessionId !== undefined) idleGates.get(sessionId)?.resolve(undefined)
    await expect.poll(async () => {
      const history = await rpc(harness, jar, 'session.history', { sessionId })
      const events = (history.body as {
        result?: { value?: { events?: Array<{ event?: { type?: string } }> } }
      }).result?.value?.events ?? []
      return events.some(entry => entry.event?.type === 'workspace/copy-back-failed')
    }).toBe(true)
    const files = await rpc(harness, jar, 'workspace.listFiles', { workspaceId })
    expect((files.body as { result?: { value?: { paths?: string[] } } }).result?.value?.paths)
      .toEqual(['keep.txt'])
  })
})
