/**
 * REAL-composition coverage: Deletion erases owned data; Ban does not.
 * Assertions observe HTTP status, RPC bodies, and owned files.
 */

import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
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
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { oneTurnLog } from '../../../session/session-persistence/tests/contract.ts'
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
      resume: () => Promise.reject(new Error('http deletion tests create live sessions')),
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
  root = await mkdtemp(join(tmpdir(), 'dsh-account-deletion-'))
  const files = join(root, 'workspaces')
  const sessions = join(root, 'sessions')
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
    "- name: '@deepseek-ai/dsh-session-persistence-jsonl'",
    '  config:',
    `    root: ${JSON.stringify(sessions)}`,
    "    compression: 'none'",
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
    ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlSessionPersistence],
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

function jsonBody(response: Response): Promise<unknown> {
  return response.json() as Promise<unknown>
}

function sessionIds(body: unknown): string[] {
  const result = (body as { result?: { ok?: boolean; value?: { items?: { sessionId: string }[] } } }).result
  expect(result?.ok).toBe(true)
  return result?.value?.items?.map(item => item.sessionId) ?? []
}

function workspaceItems(body: unknown): { workspaceId: string; path: string }[] {
  const result = (body as {
    result?: { ok?: boolean; value?: { items?: { workspaceId: string; path: string }[] } }
  }).result
  expect(result?.ok).toBe(true)
  return result?.value?.items ?? []
}

interface OwnedSeed {
  accountId: string
  sessionId: string
  workspacePath: string
  logPath: string
}

async function seedOwned(harness: Harness, jar: CookieJar, title: string): Promise<OwnedSeed> {
  const created = await rpc(harness, jar, 'workspace.create', { title })
  const workspace = (created.body as {
    result?: { value?: { workspace: { workspaceId: string; path: string } } }
  }).result?.value?.workspace
  expect(workspace?.path).toEqual(expect.any(String))
  expect((await rpc(harness, jar, 'workspace.write', {
    workspaceId: workspace!.workspaceId, path: 'note.txt', data: `note-${title}`,
  })).body as { result?: { ok?: boolean } }).toMatchObject({ result: { ok: true } })
  const sessionCreated = await rpc(harness, jar, 'session.create', { workspaceId: workspace!.workspaceId })
  const sessionId = (sessionCreated.body as { result?: { value?: { sessionId?: string } } }).result?.value?.sessionId
  expect(sessionId).toEqual(expect.any(String))
  const live = context!.sessions.get(sessionId as SessionId)
  expect(live?.header.owner).toEqual(expect.any(String))
  const accountId = live!.header.owner!
  const detached = { ...live!.header, id: SessionId(`${sessionId!}-disk`) }
  await context!.sessionPersistence.create(detached)
  await context!.sessionPersistence.append(detached.id, oneTurnLog())
  const location = context!.sessionPersistence.locate(detached)
  expect(location?.path).toEqual(expect.any(String))
  await stat(workspace!.path)
  await stat(location!.path)
  return {
    accountId,
    sessionId: sessionId!,
    workspacePath: workspace!.path,
    logPath: location!.path,
  }
}

describe('Deletion vs Ban over HTTP', () => {
  it('erases only the deleted Account; Ban leaves data; the email can register again', {
    timeout: 60_000,
  }, async () => {
    const harness = await boot()
    const password = 'correct-horse'
    const operatorJar = await signInAccount(harness, 'ops@example.com', password)
    const goneJar = await signInAccount(harness, 'gone@example.com', password)
    const keepJar = await signInAccount(harness, 'keep@example.com', password)
    const bannedJar = await signInAccount(harness, 'banned@example.com', password)

    const gone = await seedOwned(harness, goneJar, 'Gone')
    const keep = await seedOwned(harness, keepJar, 'Keep')
    const banned = await seedOwned(harness, bannedJar, 'Banned')

    expect(await jsonBody(await raw(harness, operatorJar, '/auth/operator/ban', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'banned@example.com' }),
    }))).toEqual({ ok: true })
    expect(await jsonBody(await raw(
      harness, operatorJar, '/auth/operator/account?email=banned@example.com',
    ))).toMatchObject({ ok: true, banned: true })
    expect(await jsonBody(await raw(harness, bannedJar, '/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'banned@example.com', password }),
    }))).toMatchObject({ ok: false, error: { code: 'email_taken' } })
    await stat(banned.workspacePath)
    await stat(banned.logPath)
    expect(sessionIds((await rpc(
      harness, operatorJar, 'session.list', {}, { [OPERATOR_ACCESS_HEADER]: 'banned@example.com' },
    )).body)).toEqual(expect.arrayContaining([banned.sessionId]))

    expect(await jsonBody(await raw(harness, goneJar, '/auth/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }))).toEqual({ ok: true })
    expect(await jsonBody(await raw(harness, goneJar, '/auth/me')))
      .toEqual({ ok: true, signedIn: false })
    expect(await jsonBody(await raw(
      harness, operatorJar, '/auth/operator/account?email=gone@example.com',
    ))).toMatchObject({ ok: false, error: { code: 'not_found' } })
    await expect(stat(gone.workspacePath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(gone.logPath)).rejects.toMatchObject({ code: 'ENOENT' })

    await stat(keep.workspacePath)
    await stat(keep.logPath)
    expect(workspaceItems((await rpc(harness, keepJar, 'workspace.list', {})).body).map(item => item.path))
      .toEqual([keep.workspacePath])
    expect(sessionIds((await rpc(harness, keepJar, 'session.list', {})).body))
      .toEqual(expect.arrayContaining([keep.sessionId]))

    expect(await jsonBody(await raw(harness, goneJar, '/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'gone@example.com', password }),
    }))).toEqual({ ok: true })
    await raw(harness, goneJar, `/verify?token=${tokenFromMailbox()}`)
    expect(await jsonBody(await raw(harness, goneJar, '/auth/sign-in', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'gone@example.com', password }),
    }))).toEqual({ ok: true })
    expect(workspaceItems((await rpc(harness, goneJar, 'workspace.list', {})).body)).toEqual([])
    expect(sessionIds((await rpc(harness, goneJar, 'session.list', {})).body)).toEqual([])
  })

  it('Operator Deletion of their own Account does not remove other Accounts', {
    timeout: 60_000,
  }, async () => {
    const harness = await boot()
    const password = 'correct-horse'
    const operatorJar = await signInAccount(harness, 'ops@example.com', password)
    const keepJar = await signInAccount(harness, 'keep@example.com', password)
    const keep = await seedOwned(harness, keepJar, 'Keep')

    expect(await jsonBody(await raw(harness, operatorJar, '/auth/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }))).toEqual({ ok: true })
    await stat(keep.workspacePath)
    await stat(keep.logPath)
    expect(await jsonBody(await raw(
      harness, keepJar, '/auth/me',
    ))).toMatchObject({ ok: true, signedIn: true, email: 'keep@example.com' })
    expect(workspaceItems((await rpc(harness, keepJar, 'workspace.list', {})).body).map(item => item.path))
      .toEqual([keep.workspacePath])
  })
})
