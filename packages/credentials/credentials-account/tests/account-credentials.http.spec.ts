/**
 * REAL-composition coverage: two Sign-in cookie jars against Host `/api`.
 * Assertions observe HTTP status and RPC bodies — not SQL rows or files.
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
import * as AccountHttp from '@deepseek-ai/dsh-account-http'
import { SIGN_IN_COOKIE } from '@deepseek-ai/dsh-account-http'
import AccountCredentialProvider from '../src/index.ts'

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
          followup: () => undefined,
          steer: () => undefined,
        })
        await options.setup?.(agentCtx)
        ctx.agents.register(agent)
        return { agent, dispose: () => Promise.resolve() }
      },
      resume: () => Promise.reject(new Error('http credential tests create live sessions')),
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
  root = await mkdtemp(join(tmpdir(), 'dsh-account-credentials-'))
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
    "- name: '@deepseek-ai/dsh-credentials-account'",
    '  config:',
    `    dshHome: ${JSON.stringify(root)}`,
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
    ['@deepseek-ai/dsh-credentials-account', AccountCredentialProvider],
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

function rpcError(body: unknown): string | undefined {
  return (body as { result?: { ok?: boolean; error?: { code: string } } }).result?.error?.code
}

function credentialView(body: unknown, ref: string): { configured?: boolean; source?: string } | undefined {
  const result = (body as {
    result?: { ok?: boolean; value?: { credentials?: Record<string, { configured?: boolean; source?: string }> } }
  }).result
  expect(result?.ok).toBe(true)
  return result?.value?.credentials?.[ref]
}

describe('Account-scoped Credentials over HTTP', () => {
  it('scopes Credentials to each Sign-in session and refuses prompts without one', { timeout: 60_000 }, async () => {
    const harness = await boot()
    const password = 'correct-horse'
    const jarA = await signInAccount(harness, 'a@example.com', password)
    const jarB = await signInAccount(harness, 'b@example.com', password)

    const me = await raw(harness, jarA, '/auth/me')
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({ ok: true, signedIn: true })

    const listed = await rpc(harness, jarA, 'session.list', {})
    expect(listed.status).toBe(200)
    expect((listed.body as { result?: { ok?: boolean } }).result?.ok).toBe(true)

    const created = await rpc(harness, jarA, 'session.create', {})
    expect(created.status).toBe(200)
    const sessionId = (created.body as { result?: { value?: { sessionId: string } } }).result?.value?.sessionId
    expect(sessionId).toEqual(expect.any(String))

    const missing = await rpc(harness, jarA, 'session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'hi' }],
    })
    expect(missing.status).toBe(200)
    expect(rpcError(missing.body)).toBe('credential-missing')

    expect(credentialView((await rpc(harness, jarA, 'credentials.describe', {
      refs: ['DEEPSEEK_API_KEY'],
    })).body, 'DEEPSEEK_API_KEY')).toMatchObject({ configured: false })

    const setA = await rpc(harness, jarA, 'credentials.set', {
      ref: 'DEEPSEEK_API_KEY',
      value: 'secret-a',
    })
    expect(setA.status).toBe(200)
    expect((setA.body as { result?: { ok?: boolean } }).result?.ok).toBe(true)

    expect(credentialView((await rpc(harness, jarA, 'credentials.describe', {
      refs: ['DEEPSEEK_API_KEY'],
    })).body, 'DEEPSEEK_API_KEY')).toMatchObject({ configured: true, source: 'account' })
    expect(credentialView((await rpc(harness, jarB, 'credentials.describe', {
      refs: ['DEEPSEEK_API_KEY'],
    })).body, 'DEEPSEEK_API_KEY')).toMatchObject({ configured: false })

    const promptA = await rpc(harness, jarA, 'session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'hi' }],
    })
    expect(rpcError(promptA.body)).not.toBe('credential-missing')
    expect((promptA.body as { result?: { ok?: boolean } }).result?.ok).toBe(true)

    const createdB = await rpc(harness, jarB, 'session.create', {})
    const sessionB = (createdB.body as { result?: { value?: { sessionId: string } } }).result?.value?.sessionId
    const promptB = await rpc(harness, jarB, 'session.prompt', {
      sessionId: sessionB,
      mode: 'queue',
      content: [{ type: 'text', text: 'hi' }],
    })
    expect(rpcError(promptB.body)).toBe('credential-missing')

    await rpc(harness, jarB, 'credentials.set', {
      ref: 'DEEPSEEK_API_KEY',
      value: 'secret-b',
    })
    expect(credentialView((await rpc(harness, jarA, 'credentials.describe', {
      refs: ['DEEPSEEK_API_KEY'],
    })).body, 'DEEPSEEK_API_KEY')).toMatchObject({ configured: true, source: 'account' })
  })
})
