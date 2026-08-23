/**
 * REAL-composition coverage: Operator read-only access vs an ordinary Account.
 * Assertions observe HTTP status, RPC bodies, mux frames, and audit JSON —
 * not SQL rows.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { Mailer, type MailMessage } from '@deepseek-ai/dsh-mailer'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import PostgresAccounts from '@deepseek-ai/dsh-account-postgres'
import { OPERATOR_ACCESS_HEADER } from '@deepseek-ai/dsh-account'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import CloudWorkspaces from '@deepseek-ai/dsh-workspace-cloud'
import * as AccountHttp from '../src/index.ts'
import { SIGN_IN_COOKIE } from '../src/index.ts'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

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
    ctx.provide('subagents', {
      listChildren: (parentId: string) => Promise.resolve(
        ctx.sessions.list()
          .filter(session => session.header.parentSession === parentId)
          .map(session => ({
            kind: 'child' as const,
            id: session.id,
            mode: 'one-shot' as const,
            hasChildren: false,
            activity: 'inactive' as const,
          })),
      ),
    } as never)
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
          followup: () => undefined,
          steer: () => undefined,
        })
        await options.setup?.(agentCtx)
        ctx.agents.register(agent)
        return { agent, dispose: () => Promise.resolve() }
      },
      resume: () => Promise.reject(new Error('http operator-access tests create live sessions')),
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
  root = await mkdtemp(join(tmpdir(), 'dsh-operator-access-'))
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
    '    operatorEmails:',
    "      - 'ops@example.com'",
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
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const response = await raw(harness, jar, `/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
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

function sessionIds(body: unknown): string[] {
  const result = (body as { result?: { ok?: boolean; value?: { items?: { sessionId: string }[] } } }).result
  expect(result?.ok).toBe(true)
  return result?.value?.items?.map(item => item.sessionId) ?? []
}

function jsonBody(response: Response): Promise<unknown> {
  return response.json() as Promise<unknown>
}

function openStream(
  harness: Harness,
  path: '/api/events.mux' | '/api/events.host',
  jar: CookieJar | undefined,
  extraHeaders: Record<string, string> = {},
): {
  socket: WebSocket
  frames: string[]
  opened: Promise<void>
  closed: Promise<number | undefined>
} {
  const frames: string[] = []
  const socket = new WebSocket(`ws://127.0.0.1:${String(harness.port)}${path}`, {
    headers: {
      ...jar === undefined ? {} : { cookie: jar.header() },
      origin: `http://127.0.0.1:${String(harness.port)}`,
      ...extraHeaders,
    },
  })
  const opened = new Promise<void>((resolve, reject) => {
    socket.once('open', () => { resolve() })
    socket.once('unexpected-response', (_req, response) => {
      response.resume()
      reject(new Error(`mux upgrade ${String(response.statusCode)}`))
    })
    socket.once('error', (error) => { reject(error) })
  })
  socket.on('message', (data) => {
    frames.push(Buffer.isBuffer(data)
      ? data.toString()
      : Array.isArray(data)
        ? Buffer.concat(data).toString()
        : Buffer.from(data).toString())
  })
  const closed = new Promise<number | undefined>((resolve) => {
    socket.once('close', (code) => { resolve(code) })
  })
  return { socket, frames, opened, closed }
}

describe('Operator read-only access over HTTP', () => {
  it('looks up by email, reads Session log and Workspace files, refuses prompt and secrets, and audits', {
    timeout: 60_000,
  }, async () => {
    const harness = await boot()
    const password = 'correct-horse'
    const target = 'user@example.com'
    const operatorJar = await signInAccount(harness, 'ops@example.com', password)
    const userJar = await signInAccount(harness, target, password)
    const otherJar = await signInAccount(harness, 'other@example.com', password)

    const missing = await raw(harness, operatorJar, '/auth/operator/account?email=missing@example.com')
    expect(await jsonBody(missing)).toMatchObject({ ok: false, error: { code: 'not_found' } })
    expect(await jsonBody(await raw(harness, userJar, `/auth/operator/account?email=${encodeURIComponent(target)}`)))
      .toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(await jsonBody(await raw(harness, undefined, `/auth/operator/account?email=${encodeURIComponent(target)}`)))
      .toMatchObject({ ok: false, error: { code: 'forbidden' } })

    const lookedUp = await jsonBody(await raw(
      harness, operatorJar, `/auth/operator/account?email=${encodeURIComponent(target)}`,
    )) as { ok: true; email: string; verified: boolean; banned: boolean }
    expect(lookedUp).toMatchObject({ ok: true, email: target, verified: true, banned: false })
    expect(lookedUp).not.toHaveProperty('events')
    expect(await jsonBody(await raw(harness, operatorJar, '/auth/operator/audit')))
      .toEqual({ ok: true, items: [] })

    const workspace = await rpc(harness, userJar, 'workspace.create', { title: 'Alpha' })
    const workspaceId = (workspace.body as {
      result?: { value?: { workspace: { workspaceId: string } } }
    }).result?.value?.workspace.workspaceId
    expect(workspaceId).toEqual(expect.any(String))
    expect((await rpc(harness, userJar, 'workspace.write', {
      workspaceId, path: 'note.txt', data: 'secret-note',
    })).body as { result?: { ok?: boolean } }).toMatchObject({ result: { ok: true } })

    const created = await rpc(harness, userJar, 'session.create', { workspaceId })
    const sessionId = (created.body as { result?: { value?: { sessionId?: string } } }).result?.value?.sessionId
    expect(sessionId).toEqual(expect.any(String))

    expect(sessionIds((await rpc(harness, otherJar, 'session.list', {})).body)).toEqual([])
    expect(rpcError((await rpc(harness, otherJar, 'session.history', { sessionId })).body))
      .toBe('session-not-found')
    expect((await rpc(harness, otherJar, 'session.list', {}, { [OPERATOR_ACCESS_HEADER]: target })).status)
      .toBe(403)

    const header = { [OPERATOR_ACCESS_HEADER]: target }
    expect(sessionIds((await rpc(harness, operatorJar, 'session.list', {}, header)).body))
      .toEqual([sessionId])
    expect(rpcError((await rpc(harness, operatorJar, 'session.history', { sessionId }, header)).body))
      .toBeUndefined()
    expect((await rpc(harness, operatorJar, 'session.history', { sessionId }, header)).body as {
      result?: { ok?: boolean }
    }).toMatchObject({ result: { ok: true } })

    expect(rpcError((await rpc(harness, operatorJar, 'goal.create', {
      sessionId, objective: 'inspect',
    }, header)).body)).toBe('operator-access-readonly')
    expect(rpcError((await rpc(harness, operatorJar, 'agentPreset.select', {
      sessionId, agentPreset: 'default',
    }, header)).body)).toBe('operator-access-readonly')
    expect(rpcError((await rpc(harness, operatorJar, 'session.prompt', {
      sessionId, mode: 'queue', content: [{ type: 'text', text: 'hi' }],
    }, header)).body)).toBe('operator-access-readonly')
    expect(rpcError((await rpc(harness, operatorJar, 'workspace.write', {
      workspaceId, path: 'pwn.txt', data: 'no',
    }, header)).body)).toBe('operator-access-readonly')
    expect(rpcError((await rpc(harness, operatorJar, 'credentials.describe', {
      refs: ['DEEPSEEK_API_KEY'],
    }, header)).body)).toBe('operator-access-readonly')
    expect(rpcError((await rpc(harness, operatorJar, 'credentials.set', {
      ref: 'DEEPSEEK_API_KEY', value: 'sk-leak',
    }, header)).body)).toBe('operator-access-readonly')

    const listedFiles = await rpc(harness, operatorJar, 'workspace.listFiles', { workspaceId }, header)
    expect((listedFiles.body as { result?: { value?: { paths?: string[] } } }).result?.value?.paths)
      .toEqual(['note.txt'])
    const readFile = await rpc(harness, operatorJar, 'workspace.read', {
      workspaceId, path: 'note.txt',
    }, header)
    expect((readFile.body as { result?: { value?: { data?: string } } }).result?.value?.data)
      .toBe('secret-note')

    const muxOp = openStream(harness, '/api/events.mux', operatorJar, header)
    const muxOther = openStream(harness, '/api/events.mux', otherJar)
    const hostOp = openStream(harness, '/api/events.host', operatorJar, header)
    await Promise.all([muxOp.opened, muxOther.opened, hostOp.opened])
    await expect.poll(() => muxOp.frames.join('\n').includes(sessionId!), { timeout: 5_000 }).toBe(true)
    expect(muxOther.frames.join('\n')).not.toContain(sessionId)
    muxOp.socket.send('{"type":"client-request"}')
    expect(await muxOp.closed).toBe(1008)
    muxOther.socket.close()
    hostOp.socket.close()

    const childId = SessionId('op-child')
    const parent = context!.sessions.get(sessionId as never)
    expect(parent?.header.owner).toEqual(expect.any(String))
    context!.sessions.create(childId, {
      meta: {
        cwd: root!,
        owner: parent!.header.owner!,
        origin: 'subagent',
        parentSession: sessionId as never,
      },
    })
    expect((await rpc(harness, operatorJar, 'subagent.history', {
      parentSessionId: sessionId,
      childSessionId: childId,
      mode: 'one-shot',
    }, header)).body as { result?: { ok?: boolean } }).toMatchObject({ result: { ok: true } })

    await rpc(harness, operatorJar, 'session.history', { sessionId }, header)
    const audit = await jsonBody(await raw(harness, operatorJar, '/auth/operator/audit')) as {
      ok: true
      items: { operatorEmail: string; sessionId?: string; targetAccountId: string }[]
    }
    expect(audit.ok).toBe(true)
    expect(audit.items.some(item => item.operatorEmail === 'ops@example.com' && item.sessionId === undefined))
      .toBe(true)
    expect(audit.items.some(item => item.sessionId === sessionId)).toBe(true)
    expect(await jsonBody(await raw(harness, userJar, '/auth/operator/audit')))
      .toMatchObject({ ok: false, error: { code: 'forbidden' } })

    const banned = await raw(harness, operatorJar, '/auth/operator/ban', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: target }),
    })
    expect(await jsonBody(banned)).toEqual({ ok: true })
    expect(await jsonBody(await raw(
      harness, operatorJar, `/auth/operator/account?email=${encodeURIComponent(target)}`,
    ))).toMatchObject({ ok: true, banned: true, verified: true })
    expect(sessionIds((await rpc(harness, operatorJar, 'session.list', {}, header)).body))
      .toEqual(expect.arrayContaining([sessionId]))
  })
})
