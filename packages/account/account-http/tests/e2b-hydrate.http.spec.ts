/**
 * REAL-composition coverage: Sign-in cookie jars against Host `/api` with the
 * E2B SDK faked. Hydrate, copy-back, the 1 GiB cap, one Executing Session,
 * and the daily E2B minute cap are observed as HTTP status and RPC bodies.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  killed: boolean
} {
  const remote = new Map<string, RemoteFile>()
  const handle = {
    world: {
      files: {
        makeDir: async (path: string): Promise<void> => {
          if (handle.killed) throw new Error('sandbox killed')
          remote.set(path, { data: new Uint8Array(), type: 'dir' })
        },
        write: async (path: string, data: string | Uint8Array): Promise<void> => {
          if (handle.killed) throw new Error('sandbox killed')
          const bytes = typeof data === 'string' ? Buffer.from(data) : data
          remote.set(path, { data: Uint8Array.from(bytes), type: 'file' })
        },
        read: async (path: string): Promise<Uint8Array> => {
          if (handle.killed) throw new Error('sandbox killed')
          const entry = remote.get(path)
          if (entry === undefined || entry.type !== 'file') throw new Error(`missing ${path}`)
          return entry.data
        },
        list: async (path: string) => {
          if (handle.killed) throw new Error('sandbox killed')
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
    },
    remote,
    created: 0,
    killed: false,
  }
  return handle
}

let root: string | undefined
let context: Context | undefined
const idleGates = new Map<string, PromiseWithResolvers<undefined>>()
const idleSettled = new Set<string>()
const mailbox: MailMessage[] = []
let currentWorld: ReturnType<typeof createRemoteWorld> | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  const e2b = context?.get('e2b')
  if (e2b instanceof FakeE2B) {
    e2b.startEnqueued?.resolve(undefined)
    e2b.stopBarrier?.hold.resolve(undefined)
  }
  for (const gate of idleGates.values()) gate.resolve(undefined)
  await new Promise(resolve => setTimeout(resolve, 100))
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  idleGates.clear()
  idleSettled.clear()
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

  set(): Promise<void> {
    return Promise.resolve()
  }
}

class FakeE2B extends Service {
  readonly perExecutingSession = true
  readonly dailyCapMinutes = 60
  readonly cwd = '/home/user/workspace'
  private readonly accountSlots = new Map<AccountId, { sessionId: SessionId; world: ReturnType<typeof createRemoteWorld> }>()
  private chain: Promise<unknown> = Promise.resolve()
  /** Resolved when `startExecutingSession` is called, before it joins the Account chain. */
  startEnqueued: PromiseWithResolvers<undefined> | undefined
  /** When set, stop waits on `hold` so a follow-up can join the Account chain. */
  stopBarrier: {
    entered: PromiseWithResolvers<undefined>
    hold: PromiseWithResolvers<undefined>
    afterDelete: boolean
  } | undefined

  constructor(ctx: Context) {
    super(ctx, 'e2b')
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.chain.then(operation, operation)
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }

  async startExecutingSession(
    accountId: AccountId,
    sessionId: SessionId,
    opts?: { onCreated?: () => Promise<void> },
  ) {
    this.startEnqueued?.resolve(undefined)
    return this.enqueue(async () => {
      const existing = this.accountSlots.get(accountId)
      if (existing !== undefined && existing.sessionId !== sessionId) {
        throw new ExecutingSessionBusyError(existing.sessionId)
      }
      const reused = existing !== undefined && existing.sessionId === sessionId
      const world = existing?.world ?? createRemoteWorld()
      if (!reused) world.created += 1
      this.accountSlots.set(accountId, { sessionId, world })
      currentWorld = world
      if (!reused) await opts?.onCreated?.()
      return { sandbox: world.world, reused }
    })
  }

  async stopExecutingSession(
    accountId: AccountId,
    sessionId: SessionId,
    opts?: { skipIf?: () => boolean; onStopped?: () => Promise<void> },
  ): Promise<void> {
    return this.enqueue(async () => {
      const barrier = this.stopBarrier
      if (barrier !== undefined && !barrier.afterDelete) {
        barrier.entered.resolve(undefined)
        await barrier.hold.promise
      }
      if (opts?.skipIf?.() === true) return
      const existing = this.accountSlots.get(accountId)
      if (existing?.sessionId === sessionId) {
        existing.world.killed = true
        this.accountSlots.delete(accountId)
        await opts?.onStopped?.()
      }
      if (barrier?.afterDelete === true) {
        barrier.entered.resolve(undefined)
        await barrier.hold.promise
      }
    })
  }

  executingSessionId(accountId: AccountId): SessionId | undefined {
    return this.accountSlots.get(accountId)?.sessionId
  }

  executingSandbox(accountId: AccountId) {
    return this.accountSlots.get(accountId)?.world.world
  }

  killLiveSlots(): void {
    for (const existing of this.accountSlots.values()) existing.world.killed = true
    this.accountSlots.clear()
  }

  hasLiveSlot(): boolean {
    return this.accountSlots.size > 0
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
        void idle.promise.then(() => { idleSettled.add(session.id) })
        const live = {
          status: 'idle' as 'idle' | 'running',
        }
        const beginTurn = (): void => {
          live.status = 'running'
          if (!idleSettled.has(session.id)) return
          idleSettled.delete(session.id)
          const next = Promise.withResolvers<undefined>()
          idleGates.set(session.id, next)
          void next.promise.then(() => { idleSettled.add(session.id) })
        }
        Object.assign(agent, {
          id: session.id,
          session,
          ctx: agentCtx,
          inbox: { nextTurn: [], nextStep: [] },
          cancel: () => undefined,
          followup: beginTurn,
          steer: beginTurn,
          whenIdle: () => {
            const gate = idleGates.get(session.id)
            return (gate?.promise ?? Promise.resolve()).then(() => { live.status = 'idle' })
          },
        })
        Object.defineProperty(agent, 'status', {
          get: () => live.status,
          enumerable: true,
          configurable: true,
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
    "- name: 'test-api-proxy'",
    "- name: '@deepseek-ai/dsh-workspace'",
    "- name: '@deepseek-ai/dsh-workspace-cloud'",
    '  config:',
    "    url: 'pglite:'",
    `    root: ${JSON.stringify(files)}`,
    "- name: '@deepseek-ai/dsh-e2b'",
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

  it('lets two Accounts execute at once', { timeout: 60_000 }, async () => {
    const harness = await boot()
    const password = 'correct-horse'
    const jarA = await signInAccount(harness, 'dual-a@example.com', password)
    const jarB = await signInAccount(harness, 'dual-b@example.com', password)
    const wsA = await rpc(harness, jarA, 'workspace.create', { title: 'A' })
    const wsB = await rpc(harness, jarB, 'workspace.create', { title: 'B' })
    const workspaceA = (wsA.body as {
      result?: { value?: { workspace?: { workspaceId?: string } } }
    }).result?.value?.workspace?.workspaceId
    const workspaceB = (wsB.body as {
      result?: { value?: { workspace?: { workspaceId?: string } } }
    }).result?.value?.workspace?.workspaceId
    const sessionA = (await rpc(harness, jarA, 'session.create', { workspaceId: workspaceA }))
      .body as { result?: { value?: { sessionId?: string } } }
    const sessionB = (await rpc(harness, jarB, 'session.create', { workspaceId: workspaceB }))
      .body as { result?: { value?: { sessionId?: string } } }
    const promptA = await rpc(harness, jarA, 'session.prompt', {
      sessionId: sessionA.result?.value?.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'a' }],
    })
    const promptB = await rpc(harness, jarB, 'session.prompt', {
      sessionId: sessionB.result?.value?.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'b' }],
    })
    expect((promptA.body as { result?: { ok?: boolean } }).result?.ok).toBe(true)
    expect((promptB.body as { result?: { ok?: boolean } }).result?.ok).toBe(true)
    const idA = sessionA.result?.value?.sessionId
    const idB = sessionB.result?.value?.sessionId
    if (idA !== undefined) idleGates.get(idA)?.resolve(undefined)
    if (idB !== undefined) idleGates.get(idB)?.resolve(undefined)
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

  it('keeps the live sandbox when a follow-up hold races stop', {
    timeout: 60_000,
  }, async () => {
    const harness = await boot()
    const jar = await signInAccount(harness, 'hold@example.com', 'correct-horse')
    const created = await rpc(harness, jar, 'workspace.create', { title: 'Hold' })
    const workspaceId = (created.body as {
      result?: { value?: { workspace?: { workspaceId?: string } } }
    }).result?.value?.workspace?.workspaceId
    await rpc(harness, jar, 'workspace.write', { workspaceId, path: 'note.txt', data: 'hello' })
    const session = await rpc(harness, jar, 'session.create', { workspaceId })
    const sessionId = (session.body as { result?: { value?: { sessionId?: string } } }).result?.value?.sessionId
    expect((await rpc(harness, jar, 'session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'go' }],
    })).status).toBe(200)
    expect(currentWorld?.created).toBe(1)
    const e2b = context?.get('e2b')
    if (!(e2b instanceof FakeE2B)) throw new Error('fake e2b missing')
    e2b.stopBarrier = {
      entered: Promise.withResolvers<undefined>(),
      hold: Promise.withResolvers<undefined>(),
      afterDelete: false,
    }
    if (sessionId !== undefined) idleGates.get(sessionId)?.resolve(undefined)
    await e2b.stopBarrier.entered.promise
    e2b.startEnqueued = Promise.withResolvers<undefined>()
    const followupPromise = rpc(harness, jar, 'session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'again' }],
    })
    await e2b.startEnqueued.promise
    e2b.stopBarrier.hold.resolve(undefined)
    const followup = await followupPromise
    expect((followup.body as { result?: { ok?: boolean } }).result?.ok).toBe(true)
    expect(currentWorld?.created).toBe(1)
    expect(currentWorld?.killed).toBe(false)
    const hydrated = currentWorld?.remote.get('/home/user/workspace/note.txt')
    expect(Buffer.from(hydrated?.data ?? new Uint8Array()).toString()).toBe('hello')
    if (sessionId !== undefined) idleGates.get(sessionId)?.resolve(undefined)
  })

  it('hydrates a replacement sandbox when stop deleted the previous slot', {
    timeout: 60_000,
  }, async () => {
    const harness = await boot()
    const jar = await signInAccount(harness, 'replace@example.com', 'correct-horse')
    const created = await rpc(harness, jar, 'workspace.create', { title: 'Replace' })
    const workspaceId = (created.body as {
      result?: { value?: { workspace?: { workspaceId?: string } } }
    }).result?.value?.workspace?.workspaceId
    await rpc(harness, jar, 'workspace.write', { workspaceId, path: 'note.txt', data: 'hello' })
    const session = await rpc(harness, jar, 'session.create', { workspaceId })
    const sessionId = (session.body as { result?: { value?: { sessionId?: string } } }).result?.value?.sessionId
    expect((await rpc(harness, jar, 'session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'go' }],
    })).status).toBe(200)
    const firstWorld = currentWorld
    expect(firstWorld?.created).toBe(1)
    await currentWorld?.world.files.write('/home/user/workspace/out.txt', Buffer.from('new'))
    if (sessionId !== undefined) idleGates.get(sessionId)?.resolve(undefined)
    await expect.poll(async () => {
      const listed = await rpc(harness, jar, 'workspace.listFiles', { workspaceId })
      return (listed.body as { result?: { value?: { paths?: string[] } } }).result?.value?.paths
    }).toEqual(['note.txt', 'out.txt'])
    const e2b = context?.get('e2b')
    if (!(e2b instanceof FakeE2B)) throw new Error('fake e2b missing')
    e2b.killLiveSlots()
    expect(firstWorld?.killed).toBe(true)
    const followup = await rpc(harness, jar, 'session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'again' }],
    })
    expect((followup.body as { result?: { ok?: boolean } }).result?.ok).toBe(true)
    expect(currentWorld).not.toBe(firstWorld)
    expect(currentWorld?.created).toBe(1)
    const hydrated = currentWorld?.remote.get('/home/user/workspace/out.txt')
    expect(hydrated).toBeDefined()
    expect(Buffer.from(hydrated?.data ?? new Uint8Array()).toString()).toBe('new')
    expect(e2b.hasLiveSlot()).toBe(true)
    expect(currentWorld?.killed).toBe(false)
    await expect.poll(() => e2b.hasLiveSlot() && currentWorld?.killed === false).toBe(true)
    const history = await rpc(harness, jar, 'session.history', { sessionId })
    const events = (history.body as {
      result?: { value?: { events?: Array<{ event?: { type?: string } }> } }
    }).result?.value?.events ?? []
    expect(events.some(entry => entry.event?.type === 'workspace/copy-back-failed')).toBe(false)
    expect(e2b.hasLiveSlot()).toBe(true)
    expect(currentWorld?.killed).toBe(false)
    if (sessionId !== undefined) idleGates.get(sessionId)?.resolve(undefined)
    await expect.poll(() => currentWorld?.killed === true || !e2b.hasLiveSlot()).toBe(true)
  })

  it('refuses a new Executing Session after 60 minutes and still allows sign-in, history, and Credentials', {
    timeout: 60_000,
  }, async () => {
    let nowMs = Date.parse('2026-03-01T22:00:00.000Z')
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs)
    const harness = await boot()
    const password = 'correct-horse'
    const email = 'daily-cap@example.com'
    const jar = await signInAccount(harness, email, password)
    const jarTab = await signInAccount(harness, email, password)

    const workspace = await rpc(harness, jar, 'workspace.create', { title: 'Cap' })
    const workspaceId = (workspace.body as {
      result?: { value?: { workspace?: { workspaceId?: string } } }
    }).result?.value?.workspace?.workspaceId
    expect((await rpc(harness, jar, 'workspace.write', {
      workspaceId, path: 'note.txt', data: 'hello',
    })).status).toBe(200)
    const sessionA = await rpc(harness, jar, 'session.create', { workspaceId })
    const sessionAId = (sessionA.body as { result?: { value?: { sessionId?: string } } })
      .result?.value?.sessionId
    const sessionB = await rpc(harness, jar, 'session.create', { workspaceId })
    const sessionBId = (sessionB.body as { result?: { value?: { sessionId?: string } } })
      .result?.value?.sessionId
    expect(sessionAId).toEqual(expect.any(String))
    expect(sessionBId).toEqual(expect.any(String))

    const historyIdle = await rpc(harness, jar, 'session.history', { sessionId: sessionAId })
    expect((historyIdle.body as { result?: { ok?: boolean } }).result?.ok).toBe(true)
    const credentialIdle = await rpc(harness, jar, 'credentials.set', {
      ref: 'DEEPSEEK_API_KEY',
      value: 'secret-before',
    })
    expect((credentialIdle.body as { result?: { ok?: boolean } }).result?.ok).toBe(true)

    const promptA = await rpc(harness, jar, 'session.prompt', {
      sessionId: sessionAId,
      mode: 'queue',
      content: [{ type: 'text', text: 'run' }],
    })
    expect((promptA.body as { result?: { ok?: boolean } }).result?.ok).toBe(true)

    const historyLive = await rpc(harness, jar, 'session.history', { sessionId: sessionAId })
    expect((historyLive.body as { result?: { ok?: boolean } }).result?.ok).toBe(true)
    const credentialLive = await rpc(harness, jar, 'credentials.set', {
      ref: 'DEEPSEEK_API_KEY',
      value: 'secret-during',
    })
    expect((credentialLive.body as { result?: { ok?: boolean } }).result?.ok).toBe(true)

    nowMs += 60 * 60 * 1000
    const liveAgain = await rpc(harness, jar, 'session.prompt', {
      sessionId: sessionAId,
      mode: 'queue',
      content: [{ type: 'text', text: 'still-live' }],
    })
    expect((liveAgain.body as { result?: { ok?: boolean } }).result?.ok).toBe(true)
    const liveTab = await rpc(harness, jarTab, 'session.prompt', {
      sessionId: sessionAId,
      mode: 'queue',
      content: [{ type: 'text', text: 'tab' }],
    })
    expect((liveTab.body as { result?: { ok?: boolean } }).result?.ok).toBe(true)

    if (sessionAId !== undefined) idleGates.get(sessionAId)?.resolve(undefined)
    const e2b = context?.get('e2b')
    if (!(e2b instanceof FakeE2B)) throw new Error('fake e2b missing')
    await expect.poll(() => e2b.hasLiveSlot()).toBe(false)

    const exhaustedSame = await rpc(harness, jar, 'session.prompt', {
      sessionId: sessionAId,
      mode: 'queue',
      content: [{ type: 'text', text: 'again-a' }],
    })
    expect(rpcError(exhaustedSame.body)).toBe('e2b-cap-exhausted')
    const exhausted = await rpc(harness, jar, 'session.prompt', {
      sessionId: sessionBId,
      mode: 'queue',
      content: [{ type: 'text', text: 'again' }],
    })
    expect(rpcError(exhausted.body)).toBe('e2b-cap-exhausted')
    const exhaustedDetails = (exhausted.body as {
      result?: { error?: { details?: { capMinutes?: number; resetsAt?: number } } }
    }).result?.error?.details
    expect(exhaustedDetails?.capMinutes).toBe(60)
    expect(exhaustedDetails?.resetsAt).toBe(Date.parse('2026-03-02T00:00:00.000Z'))

    const historyAfter = await rpc(harness, jar, 'session.history', { sessionId: sessionAId })
    expect((historyAfter.body as { result?: { ok?: boolean } }).result?.ok).toBe(true)
    const credentialAfter = await rpc(harness, jar, 'credentials.set', {
      ref: 'DEEPSEEK_API_KEY',
      value: 'secret-after',
    })
    expect((credentialAfter.body as { result?: { ok?: boolean } }).result?.ok).toBe(true)

    const signedOut = await raw(harness, jar, '/auth/sign-out', { method: 'POST' })
    expect(signedOut.status).toBe(200)
    const jarAgain = new CookieJar()
    const signedIn = await raw(harness, jarAgain, '/auth/sign-in', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    expect(signedIn.status).toBe(200)
    expect(jarAgain.header()).toContain(SIGN_IN_COOKIE)
    const historySignedIn = await rpc(harness, jarAgain, 'session.history', { sessionId: sessionAId })
    expect((historySignedIn.body as { result?: { ok?: boolean } }).result?.ok).toBe(true)

    nowMs = Date.parse('2026-03-02T00:00:00.000Z')
    const nextDay = await rpc(harness, jarAgain, 'session.prompt', {
      sessionId: sessionBId,
      mode: 'queue',
      content: [{ type: 'text', text: 'tomorrow' }],
    })
    expect((nextDay.body as { result?: { ok?: boolean } }).result?.ok).toBe(true)
    if (sessionBId !== undefined) idleGates.get(sessionBId)?.resolve(undefined)
  })

  it('charges a replacement Executing Session that starts in the previous stop window', {
    timeout: 60_000,
  }, async () => {
    let nowMs = Date.parse('2026-04-01T10:00:00.000Z')
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs)
    const harness = await boot()
    const jar = await signInAccount(harness, 'race-cap@example.com', 'correct-horse')
    const created = await rpc(harness, jar, 'workspace.create', { title: 'Race' })
    const workspaceId = (created.body as {
      result?: { value?: { workspace?: { workspaceId?: string } } }
    }).result?.value?.workspace?.workspaceId
    await rpc(harness, jar, 'workspace.write', { workspaceId, path: 'note.txt', data: 'hello' })
    const sessionA = (await rpc(harness, jar, 'session.create', { workspaceId }))
      .body as { result?: { value?: { sessionId?: string } } }
    const sessionB = (await rpc(harness, jar, 'session.create', { workspaceId }))
      .body as { result?: { value?: { sessionId?: string } } }
    const sessionC = (await rpc(harness, jar, 'session.create', { workspaceId }))
      .body as { result?: { value?: { sessionId?: string } } }
    const sessionAId = sessionA.result?.value?.sessionId
    const sessionBId = sessionB.result?.value?.sessionId
    const sessionCId = sessionC.result?.value?.sessionId

    expect((await rpc(harness, jar, 'session.prompt', {
      sessionId: sessionAId,
      mode: 'queue',
      content: [{ type: 'text', text: 'a' }],
    })).status).toBe(200)
    const e2b = context?.get('e2b')
    if (!(e2b instanceof FakeE2B)) throw new Error('fake e2b missing')
    e2b.stopBarrier = {
      entered: Promise.withResolvers<undefined>(),
      hold: Promise.withResolvers<undefined>(),
      afterDelete: false,
    }
    if (sessionAId !== undefined) idleGates.get(sessionAId)?.resolve(undefined)
    await e2b.stopBarrier.entered.promise
    e2b.startEnqueued = Promise.withResolvers<undefined>()
    const promptBPromise = rpc(harness, jar, 'session.prompt', {
      sessionId: sessionBId,
      mode: 'queue',
      content: [{ type: 'text', text: 'b' }],
    })
    await e2b.startEnqueued.promise
    e2b.stopBarrier.hold.resolve(undefined)
    const promptB = await promptBPromise
    expect((promptB.body as { result?: { ok?: boolean } }).result?.ok).toBe(true)

    nowMs += 60 * 60 * 1000
    if (sessionBId !== undefined) idleGates.get(sessionBId)?.resolve(undefined)
    await expect.poll(() => e2b.hasLiveSlot()).toBe(false)
    const exhausted = await rpc(harness, jar, 'session.prompt', {
      sessionId: sessionCId,
      mode: 'queue',
      content: [{ type: 'text', text: 'c' }],
    })
    expect(rpcError(exhausted.body)).toBe('e2b-cap-exhausted')
  })
})
