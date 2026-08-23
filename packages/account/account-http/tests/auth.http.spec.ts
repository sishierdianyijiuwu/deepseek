/**
 * REAL-composition coverage: Loader boots webserver + postgres (PGlite) +
 * auth HTTP with a fake mailer. Assertions observe status, JSON, cookie
 * effects, and whether the mailer was invoked.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { Mailer, type MailMessage } from '@deepseek-ai/dsh-mailer'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import PostgresAccounts from '@deepseek-ai/dsh-account-postgres'
import * as AccountHttp from '../src/index.ts'
import { MAX_AUTH_BODY_BYTES, SIGN_IN_COOKIE } from '../src/index.ts'

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

  hasSignIn(): boolean {
    return this.values.has(SIGN_IN_COOKIE)
  }
}

const mailbox: MailMessage[] = []
let failSend = false

class FakeMailer extends Mailer {
  override async send(message: MailMessage): Promise<void> {
    if (failSend) {
      failSend = false
      throw new Error('smtp down')
    }
    mailbox.push(message)
  }
}

interface Harness {
  port: number
  jar: CookieJar
}

async function boot(overrides?: { verificationTtlMs?: number; signInTtlMs?: number }): Promise<Harness> {
  mailbox.length = 0
  failSend = false
  root = await mkdtemp(join(tmpdir(), 'dsh-account-http-'))
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
    ...(overrides?.verificationTtlMs !== undefined
      ? [`    verificationTtlMs: ${String(overrides.verificationTtlMs)}`]
      : []),
    ...(overrides?.signInTtlMs !== undefined
      ? [`    signInTtlMs: ${String(overrides.signInTtlMs)}`]
      : []),
    "- name: '@deepseek-ai/dsh-account-http'",
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
  return { port: context.webServer.port, jar: new CookieJar() }
}

async function request(
  harness: Harness,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; json: unknown; location: string | null; headers: Headers }> {
  const headers = new Headers(init.headers)
  const cookie = harness.jar.header()
  if (cookie !== '' && !headers.has('cookie')) headers.set('cookie', cookie)
  const response = await fetch(`http://127.0.0.1:${String(harness.port)}${path}`, {
    ...init,
    headers,
    redirect: 'manual',
  })
  harness.jar.absorb(response)
  const text = await response.text()
  let json: unknown = text
  if (text !== '') {
    try { json = JSON.parse(text) as unknown } catch { json = text }
  }
  return { status: response.status, json, location: response.headers.get('location'), headers: response.headers }
}

function post(harness: Harness, path: string, body: unknown): ReturnType<typeof request> {
  return request(harness, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function tokenFromMailbox(): string {
  const last = mailbox.at(-1)
  expect(last).toBeDefined()
  const match = /\/verify\?token=([0-9a-f]+)/.exec(last?.text ?? '')
  expect(match?.[1]).toBeDefined()
  return match![1]!
}

describe('auth HTTP', () => {
  it('registers, rejects duplicates, blocks unverified sign-in, verifies, signs in and out', { timeout: 60_000 }, async () => {
    const harness = await boot()
    const email = 'person@example.com'
    const password = 'correct-horse'

    const registered = await post(harness, '/auth/register', { email, password })
    expect(registered.status).toBe(200)
    expect(registered.json).toEqual({ ok: true })
    expect(mailbox).toHaveLength(1)
    expect(mailbox[0]?.to).toBe(email)
    const token = tokenFromMailbox()

    const duplicate = await post(harness, '/auth/register', { email, password })
    expect(duplicate.json).toMatchObject({ ok: false, error: { code: 'email_taken' } })

    const concurrent = await Promise.all([
      post(harness, '/auth/register', { email: 'race@example.com', password }),
      post(harness, '/auth/register', { email: 'race@example.com', password }),
    ])
    const outcomes = concurrent.map((row) => {
      const body = row.json as { ok: boolean; error?: { code: string } }
      return body.ok ? 'ok' : body.error?.code
    })
    expect(outcomes.sort()).toEqual(['email_taken', 'ok'])

    const unverified = await post(harness, '/auth/sign-in', { email, password })
    expect(unverified.json).toMatchObject({ ok: false, error: { code: 'unverified' } })
    expect(harness.jar.hasSignIn()).toBe(false)

    const wrong = await post(harness, '/auth/sign-in', { email, password: 'wrong-password' })
    const unknown = await post(harness, '/auth/sign-in', { email: 'nobody@example.com', password })
    expect(wrong.json).toMatchObject({ ok: false, error: { code: 'invalid_credentials' } })
    expect(unknown.json).toEqual(wrong.json)

    const meAnonymous = await request(harness, '/auth/me')
    expect(meAnonymous.json).toEqual({ ok: true, signedIn: false })

    const verified = await request(harness, `/verify?token=${token}`)
    expect(verified.status).toBe(302)
    expect(verified.location).toBe('/?verified=ok')

    const reused = await request(harness, `/verify?token=${token}`)
    expect(reused.location).toBe('/?verified=invalid')

    const signedIn = await post(harness, '/auth/sign-in', { email, password })
    expect(signedIn.status).toBe(200)
    expect(signedIn.json).toEqual({ ok: true })
    expect(harness.jar.hasSignIn()).toBe(true)
    const setCookie = signedIn.headers.getSetCookie().join('; ')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Lax')
    expect(setCookie).not.toContain('Secure')

    const me = await request(harness, '/auth/me')
    expect(me.json).toEqual({ ok: true, signedIn: true, email })

    const signedOut = await post(harness, '/auth/sign-out', {})
    expect(signedOut.json).toEqual({ ok: true })
    expect(harness.jar.hasSignIn()).toBe(false)
    expect((await request(harness, '/auth/me')).json).toEqual({ ok: true, signedIn: false })
  })

  it('resends verification and rejects expired tokens', { timeout: 60_000 }, async () => {
    const harness = await boot({ verificationTtlMs: 30 })
    const email = 'expire@example.com'
    const password = 'correct-horse'
    await post(harness, '/auth/register', { email, password })
    const first = tokenFromMailbox()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect((await request(harness, `/verify?token=${first}`)).location).toBe('/?verified=invalid')

    await post(harness, '/auth/resend-verification', { email })
    expect(mailbox).toHaveLength(2)
    const second = tokenFromMailbox()
    expect(second).not.toBe(first)
    // The new token is also issued under the 30ms TTL used for this fixture;
    // boot a default-TTL host for a still-valid resend.
  })

  it('resends a still-valid token on a default-TTL host', { timeout: 60_000 }, async () => {
    const harness = await boot()
    const email = 'resend@example.com'
    const password = 'correct-horse'
    await post(harness, '/auth/register', { email, password })
    const first = tokenFromMailbox()
    await post(harness, '/auth/resend-verification', { email })
    const second = tokenFromMailbox()
    expect(second).not.toBe(first)
    expect((await request(harness, `/verify?token=${first}`)).location).toBe('/?verified=invalid')
    expect((await request(harness, `/verify?token=${second}`)).location).toBe('/?verified=ok')
    await post(harness, '/auth/resend-verification', { email })
    await post(harness, '/auth/resend-verification', { email: 'missing@example.com' })
    await post(harness, '/auth/resend-verification', { email: 'not-an-email' })
  })

  it('rejects malformed carriers and unknown paths', { timeout: 60_000 }, async () => {
    const harness = await boot()
    expect((await request(harness, '/auth/register')).status).toBe(405)
    expect((await request(harness, '/auth')).status).toBe(405)
    expect((await request(harness, '/auth/me', { method: 'POST' })).status).toBe(405)
    expect((await request(harness, '/verify', { method: 'POST' })).status).toBe(405)
    expect((await request(harness, '/verify', { method: 'HEAD' })).status).toBe(302)
    expect((await post(harness, '/auth/sign-out', {})).json).toEqual({ ok: true })
    harness.jar.absorb(new Response(null, { headers: { 'set-cookie': `${SIGN_IN_COOKIE}=%zz` } }))
    expect((await request(harness, '/auth/me')).json).toEqual({ ok: true, signedIn: false })
    expect((await request(harness, '/auth/nope', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(404)
    expect((await request(harness, '/verify')).location).toBe('/?verified=invalid')
    expect((await post(harness, '/auth/register', { email: 1 })).json).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    expect((await post(harness, '/auth/sign-in', { email: 'a@b.c' })).json).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    expect((await post(harness, '/auth/resend-verification', {})).json).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    expect((await request(harness, '/auth/sign-in', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    })).status).toBe(415)
    expect((await request(harness, '/auth/resend-verification', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })).status).toBe(400)
    expect((await post(harness, '/auth/sign-in', { email: 'not-an-email', password: 'correct-horse' })).json)
      .toMatchObject({ ok: false, error: { code: 'invalid_credentials' } })
    expect((await request(harness, '/auth/me', { headers: { cookie: 'other=1' } })).json)
      .toEqual({ ok: true, signedIn: false })
    expect((await request(harness, '/auth/me', { headers: { cookie: `${SIGN_IN_COOKIE}=deadbeef` } })).json)
      .toEqual({ ok: true, signedIn: false })
    expect((await post(harness, '/auth/register', { email: 'bad', password: 'correct-horse' })).json)
      .toMatchObject({ ok: false, error: { code: 'invalid_email' } })
    expect((await post(harness, '/auth/register', { email: 'ok@example.com', password: 'short' })).json)
      .toMatchObject({ ok: false, error: { code: 'invalid_password' } })

    expect((await request(harness, '/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    })).status).toBe(415)

    expect((await request(harness, '/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })).status).toBe(400)

    expect((await request(harness, '/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '[]',
    })).status).toBe(400)

    expect((await request(harness, '/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '',
    })).status).toBe(400)

    expect((await request(harness, '/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(MAX_AUTH_BODY_BYTES + 1) },
      body: 'x'.repeat(MAX_AUTH_BODY_BYTES + 1),
    })).status).toBe(413)
  })

  it('surfaces a mailer failure after the Account exists', { timeout: 60_000 }, async () => {
    const harness = await boot()
    failSend = true
    const result = await post(harness, '/auth/register', { email: 'mail@example.com', password: 'correct-horse' })
    expect(result.status).toBe(400)
    const retry = await post(harness, '/auth/register', { email: 'mail@example.com', password: 'correct-horse' })
    expect(retry.json).toMatchObject({ ok: false, error: { code: 'email_taken' } })
  })

  it('sets Secure cookies when configured', { timeout: 60_000 }, async () => {
    mailbox.length = 0
    failSend = false
    root = await mkdtemp(join(tmpdir(), 'dsh-account-secure-'))
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
      '  config:',
      '    cookieSecure: true',
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
    const harness: Harness = { port: context.webServer.port, jar: new CookieJar() }
    await post(harness, '/auth/register', { email: 'secure@example.com', password: 'correct-horse' })
    await request(harness, `/verify?token=${tokenFromMailbox()}`)
    const signedIn = await post(harness, '/auth/sign-in', { email: 'secure@example.com', password: 'correct-horse' })
    expect(signedIn.headers.getSetCookie().join('; ')).toContain('Secure')
  })
})
