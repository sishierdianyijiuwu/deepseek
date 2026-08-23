/**
 * REAL-composition coverage: two Sign-in cookie jars against Host `/api`.
 * Assertions observe HTTP status, RPC bodies, and mux frames — not SQL rows.
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
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import * as AccountHttp from '../src/index.ts'
import { SIGN_IN_COOKIE } from '../src/index.ts'

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

  set(name: string, value: string): void {
    this.values.set(name, value)
  }

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
  static inject = ['sessions', 'agents', 'userQuestions']

  constructor(ctx: Context) {
    super(ctx, 'apiProxy')
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
      resume: () => Promise.reject(new Error('http isolation tests create live sessions')),
    })
    ctx.provide('sessionQuery', {
      searchSessions: (req: { sessionFilters?: readonly { kind: string; values?: readonly string[] }[] }) => {
        const allowed = new Set(req.sessionFilters?.find(item => item.kind === 'id')?.values ?? [])
        return Promise.resolve({
          items: ctx.sessions.list()
            .filter(session => allowed.has(session.id))
            .map(session => ({
              header: session.header,
              live: true,
              persisted: false,
              bestMatch: {
                sessionId: session.id,
                seq: 0,
                type: 'user/message',
                time: 1,
                surface: 'current',
                snippet: `hit ${session.id}`,
              },
            })),
        })
      },
    } as never)
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
  root = await mkdtemp(join(tmpdir(), 'dsh-account-sessions-'))
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
    "- name: 'test-api-proxy'",
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
    ['test-api-proxy', IsolatedApiProxy],
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

function sessionIds(body: unknown): string[] {
  const result = (body as { result?: { ok?: boolean; value?: { items?: { sessionId: string }[] } } }).result
  expect(result?.ok).toBe(true)
  return result?.value?.items?.map(item => item.sessionId) ?? []
}

function rpcError(body: unknown): string | undefined {
  return (body as { result?: { ok?: boolean; error?: { code: string } } }).result?.error?.code
}

function openMux(harness: Harness, jar: CookieJar | undefined): {
  socket: WebSocket
  frames: string[]
  opened: Promise<void>
  status: Promise<number | undefined>
} {
  const frames: string[] = []
  let status: number | undefined
  const socket = new WebSocket(`ws://127.0.0.1:${String(harness.port)}/api/events.mux`, {
    headers: {
      ...jar === undefined ? {} : { cookie: jar.header() },
      origin: `http://127.0.0.1:${String(harness.port)}`,
    },
  })
  const opened = new Promise<void>((resolve, reject) => {
    socket.once('open', () => { resolve() })
    socket.once('unexpected-response', (_req, response) => {
      status = response.statusCode
      response.resume()
      reject(new Error(`mux upgrade ${String(response.statusCode)}`))
    })
    socket.once('error', (error) => { reject(error) })
  })
  socket.on('message', (data) => {
    frames.push(String(data))
  })
  return {
    socket,
    frames,
    opened,
    status: opened.then(() => status, () => status),
  }
}

describe('Account-owned Sessions over HTTP', () => {
  it('rejects unauthenticated /api, isolates two cookie jars, and keeps auth/static open', { timeout: 60_000 }, async () => {
    const harness = await boot()
    const password = 'correct-horse'

    const anonymousList = await rpc(harness, undefined, 'session.list', {})
    expect(anonymousList.status).toBe(401)
    expect(anonymousList.body).toBe('unauthorized')

    const anonymousMe = await raw(harness, undefined, '/auth/me')
    expect(anonymousMe.status).toBe(200)
    expect(await anonymousMe.json()).toEqual({ ok: true, signedIn: false })

    const missingPage = await raw(harness, undefined, '/no-such-page')
    expect(missingPage.status).toBe(404)

    const jarA = await signInAccount(harness, 'a@example.com', password)
    const jarB = await signInAccount(harness, 'b@example.com', password)

    const created = await rpc(harness, jarA, 'session.create', {})
    expect(created.status).toBe(200)
    const createdBody = created.body as { result?: { ok?: boolean; value?: { sessionId: string } } }
    expect(createdBody.result?.ok).toBe(true)
    const sessionId = createdBody.result?.value?.sessionId
    expect(sessionId).toEqual(expect.any(String))

    expect(sessionIds((await rpc(harness, jarA, 'session.list', {})).body)).toEqual([sessionId])
    expect(sessionIds((await rpc(harness, jarB, 'session.list', {})).body)).toEqual([])

    const historyB = await rpc(harness, jarB, 'session.history', { sessionId })
    expect(historyB.status).toBe(200)
    expect(rpcError(historyB.body)).toBe('session-not-found')

    const promptB = await rpc(harness, jarB, 'session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'hi' }],
    })
    expect(rpcError(promptB.body)).toBe('session-not-found')

    expect(rpcError((await rpc(harness, jarA, 'session.updateQueue', {
      sessionId,
      itemId: 'item-1',
      action: { kind: 'remove' },
    })).body)).toBe('queue-item-not-found')
    expect(rpcError((await rpc(harness, jarB, 'session.cancel', { sessionId })).body)).toBe('session-not-found')
    expect(rpcError((await rpc(harness, jarB, 'session.updateQueue', {
      sessionId,
      itemId: 'item-1',
      action: { kind: 'remove' },
    })).body)).toBe('session-not-found')
    expect(rpcError((await rpc(harness, jarB, 'session.fork', { sessionId })).body)).toBe('session-not-found')
    expect((await raw(harness, jarB, `/api/session.export?sessionId=${encodeURIComponent(sessionId!)}`)).status).toBe(404)
    expect(sessionIds((await rpc(harness, jarA, 'session.list', {})).body)).toEqual([sessionId])

    const createdB = await rpc(harness, jarB, 'session.create', {})
    const sessionB = (createdB.body as { result?: { value?: { sessionId: string } } }).result?.value?.sessionId
    expect(sessionIds((await rpc(harness, jarA, 'session.list', {})).body)).toEqual([sessionId])
    expect(sessionIds((await rpc(harness, jarB, 'session.list', {})).body)).toEqual([sessionB])

    const searchA = await rpc(harness, jarA, 'session.search', { query: 'hit' })
    const searchB = await rpc(harness, jarB, 'session.search', { query: 'hit' })
    expect((searchA.body as { result?: { value?: { items?: { sessionId: string }[] } } }).result?.value?.items
      ?.map(item => item.sessionId)).toEqual([sessionId])
    expect((searchB.body as { result?: { value?: { items?: { sessionId: string }[] } } }).result?.value?.items
      ?.map(item => item.sessionId)).toEqual([sessionB])

    const dead = new CookieJar()
    dead.set(SIGN_IN_COOKIE, 'deadbeef')
    expect((await rpc(harness, dead, 'session.list', {})).status).toBe(401)

    const anonymousMux = openMux(harness, undefined)
    await expect(anonymousMux.opened).rejects.toThrow()
    expect(await anonymousMux.status).toBe(401)
    anonymousMux.socket.close()

    context?.sessions.create(SessionId('orphan'), { meta: { cwd: root as string } })
    expect(sessionIds((await rpc(harness, jarA, 'session.list', {})).body)).toEqual([sessionId])
  })

  it('does not subscribe a second cookie jar to the other Account\'s mux frames', { timeout: 60_000 }, async () => {
    const harness = await boot()
    const password = 'correct-horse'
    const jarA = await signInAccount(harness, 'mux-a@example.com', password)
    const jarB = await signInAccount(harness, 'mux-b@example.com', password)
    const muxA = openMux(harness, jarA)
    const muxB = openMux(harness, jarB)
    await Promise.all([muxA.opened, muxB.opened])

    const created = await rpc(harness, jarA, 'session.create', {})
    const sessionId = (created.body as { result?: { value?: { sessionId: string } } }).result?.value?.sessionId
    expect(sessionId).toEqual(expect.any(String))
    await expect.poll(() => muxA.frames.join('\n').includes(sessionId!), { timeout: 5_000 }).toBe(true)
    muxA.socket.close()
    muxB.socket.close()
    expect(muxB.frames.join('\n')).not.toContain(sessionId)
  })
})
