/**
 * REAL-composition coverage: Loader boots webserver + postgres (PGlite) +
 * auth HTTP with a fake mailer. Assertions observe status, JSON, cookie
 * effects, and whether the mailer was invoked.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { Mailer, type MailMessage } from '@deepseek-ai/dsh-mailer'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import PostgresAccounts, { DEFAULT_SIGN_IN_TTL_MS } from '@deepseek-ai/dsh-account-postgres'
import * as AccountHttp from '../src/index.ts'
import { MAX_AUTH_BODY_BYTES, SIGN_IN_COOKIE } from '../src/index.ts'

const CLOCK_ORIGIN = 1_700_000_000_000
const DAY_MS = 24 * 60 * 60 * 1000
let nowMs = CLOCK_ORIGIN

let root: string | undefined
let context: Context | undefined

beforeEach(() => {
  nowMs = CLOCK_ORIGIN
  vi.spyOn(Date, 'now').mockImplementation(() => nowMs)
})

afterEach(async () => {
  vi.restoreAllMocks()
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
    if (failSend) throw new Error('smtp down')
    mailbox.push(message)
  }
}

interface Harness {
  port: number
  jar: CookieJar
}

async function boot(overrides?: {
  verificationTtlMs?: number
  signInTtlMs?: number
  passwordResetTtlMs?: number
}): Promise<Harness> {
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
    ...(overrides?.passwordResetTtlMs !== undefined
      ? [`    passwordResetTtlMs: ${String(overrides.passwordResetTtlMs)}`]
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
  jar: CookieJar = harness.jar,
): Promise<{ status: number; json: unknown; location: string | null; headers: Headers }> {
  const headers = new Headers(init.headers)
  const cookie = jar.header()
  if (cookie !== '' && !headers.has('cookie')) headers.set('cookie', cookie)
  const response = await fetch(`http://127.0.0.1:${String(harness.port)}${path}`, {
    ...init,
    headers,
    redirect: 'manual',
  })
  jar.absorb(response)
  const text = await response.text()
  let json: unknown = text
  if (text !== '') {
    try { json = JSON.parse(text) as unknown } catch { json = text }
  }
  return { status: response.status, json, location: response.headers.get('location'), headers: response.headers }
}

function post(
  harness: Harness,
  path: string,
  body: unknown,
  jar?: CookieJar,
): ReturnType<typeof request> {
  return request(harness, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, jar)
}

function tokenFromMailbox(kind: 'verify' | 'reset' = 'verify'): string {
  const last = mailbox.at(-1)
  expect(last).toBeDefined()
  const match = new RegExp(`/${kind}\\?token=([0-9a-f]+)`).exec(last?.text ?? '')
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

    const scanned = await request(harness, `/verify?token=${token}`, { method: 'HEAD' })
    expect(scanned.status).toBe(200)
    expect(scanned.location).toBeNull()

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
    expect(setCookie).toContain(`Max-Age=${String(DEFAULT_SIGN_IN_TTL_MS / 1000)}`)
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
    nowMs += 50
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
    expect((await request(harness, '/verify', { method: 'HEAD' })).status).toBe(200)
    expect((await post(harness, '/auth/sign-out', {})).json).toEqual({ ok: true })
    harness.jar.absorb(new Response(null, { headers: { 'set-cookie': `${SIGN_IN_COOKIE}=%zz` } }))
    expect((await request(harness, '/auth/me')).json).toEqual({ ok: true, signedIn: false })
    expect((await request(harness, '/auth/nope', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(404)
    expect((await request(harness, '/verify')).location).toBe('/?verified=invalid')
    expect((await post(harness, '/auth/register', { email: 1 })).json).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    expect((await post(harness, '/auth/sign-in', { email: 'a@b.c' })).json).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    expect((await post(harness, '/auth/resend-verification', {})).json).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    expect((await post(harness, '/auth/request-password-reset', {})).json).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    expect((await post(harness, '/auth/reset-password', { token: 'x' })).json).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    expect((await request(harness, '/auth/request-password-reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })).status).toBe(400)
    expect((await request(harness, '/auth/reset-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })).status).toBe(400)
    expect((await request(harness, '/reset', { method: 'POST' })).status).toBe(405)
    expect((await request(harness, '/reset', { method: 'HEAD' })).status).toBe(200)
    expect((await request(harness, '/reset')).location).toBe('/?reset=')
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
    expect(result.status).toBe(200)
    expect(result.json).toMatchObject({ ok: false, error: { code: 'mail_failed' } })
    expect(mailbox).toHaveLength(0)
    const silentResend = await post(harness, '/auth/resend-verification', { email: 'mail@example.com' })
    expect(silentResend.json).toEqual({ ok: true })
    expect(mailbox).toHaveLength(0)
    failSend = false
    const resend = await post(harness, '/auth/resend-verification', { email: 'mail@example.com' })
    expect(resend.json).toEqual({ ok: true })
    expect(mailbox).toHaveLength(1)
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

  it('resets the Password, ends every Sign-in session, and refuses reuse', { timeout: 60_000 }, async () => {
    const harness = await boot()
    const email = 'reset@example.com'
    const password = 'correct-horse'
    const nextPassword = 'correct-zebra'
    await post(harness, '/auth/register', { email, password })
    await request(harness, `/verify?token=${tokenFromMailbox()}`)

    const silentUnknown = await post(harness, '/auth/request-password-reset', { email: 'nobody@example.com' })
    expect(silentUnknown.json).toEqual({ ok: true })
    expect(mailbox).toHaveLength(1)

    const unverified = await post(harness, '/auth/register', { email: 'unverified-reset@example.com', password })
    expect(unverified.json).toEqual({ ok: true })
    const beforeUnverified = mailbox.length
    expect((await post(harness, '/auth/request-password-reset', { email: 'unverified-reset@example.com' })).json)
      .toEqual({ ok: true })
    expect(mailbox).toHaveLength(beforeUnverified)

    await post(harness, '/auth/sign-in', { email, password })
    const other = new CookieJar()
    await post(harness, '/auth/sign-in', { email, password }, other)
    expect(harness.jar.hasSignIn()).toBe(true)
    expect(other.hasSignIn()).toBe(true)

    failSend = true
    expect((await post(harness, '/auth/request-password-reset', { email })).json).toEqual({ ok: true })
    expect(mailbox).toHaveLength(beforeUnverified)
    failSend = false

    expect((await post(harness, '/auth/request-password-reset', { email })).json).toEqual({ ok: true })
    const firstReset = tokenFromMailbox('reset')
    expect((await post(harness, '/auth/request-password-reset', { email })).json).toEqual({ ok: true })
    const resetToken = tokenFromMailbox('reset')
    expect(resetToken).not.toBe(firstReset)

    const scanned = await request(harness, `/reset?token=${resetToken}`, { method: 'HEAD' })
    expect(scanned.status).toBe(200)
    expect(scanned.location).toBeNull()
    const landed = await request(harness, `/reset?token=${resetToken}`)
    expect(landed.status).toBe(302)
    expect(landed.location).toBe(`/?reset=${resetToken}`)

    expect((await post(harness, '/auth/reset-password', { token: firstReset, password: nextPassword })).json)
      .toMatchObject({ ok: false, error: { code: 'invalid_or_expired' } })
    expect((await post(harness, '/auth/reset-password', { token: resetToken, password: 'short' })).json)
      .toMatchObject({ ok: false, error: { code: 'invalid_password' } })

    const reset = await post(harness, '/auth/reset-password', { token: resetToken, password: nextPassword })
    expect(reset.json).toEqual({ ok: true })
    expect(harness.jar.hasSignIn()).toBe(false)
    expect((await request(harness, '/auth/me')).json).toEqual({ ok: true, signedIn: false })
    expect((await request(harness, '/auth/me', {}, other)).json).toEqual({ ok: true, signedIn: false })

    expect((await post(harness, '/auth/sign-in', { email, password })).json)
      .toMatchObject({ ok: false, error: { code: 'invalid_credentials' } })
    const signedIn = await post(harness, '/auth/sign-in', { email, password: nextPassword })
    expect(signedIn.json).toEqual({ ok: true })
    expect(harness.jar.hasSignIn()).toBe(true)

    expect((await post(harness, '/auth/reset-password', { token: resetToken, password: 'correct-horse2' })).json)
      .toMatchObject({ ok: false, error: { code: 'invalid_or_expired' } })
    expect((await post(harness, '/auth/reset-password', { token: '', password: nextPassword })).json)
      .toMatchObject({ ok: false, error: { code: 'invalid_or_expired' } })
    expect((await post(harness, '/auth/request-password-reset', { email: 'not-an-email' })).json)
      .toEqual({ ok: true })
  })

  it('expires a password-reset token under a fake clock', { timeout: 60_000 }, async () => {
    const harness = await boot({ passwordResetTtlMs: 30 })
    const email = 'expire-reset@example.com'
    const password = 'correct-horse'
    await post(harness, '/auth/register', { email, password })
    await request(harness, `/verify?token=${tokenFromMailbox()}`)
    await post(harness, '/auth/request-password-reset', { email })
    const token = tokenFromMailbox('reset')
    nowMs += 31
    expect((await post(harness, '/auth/reset-password', { token, password: 'correct-zebra' })).json)
      .toMatchObject({ ok: false, error: { code: 'invalid_or_expired' } })
  })

  it('slides a Sign-in session on /auth/me and persists past a browser close', { timeout: 60_000 }, async () => {
    const harness = await boot()
    const email = 'slide@example.com'
    const password = 'correct-horse'
    await post(harness, '/auth/register', { email, password })
    await request(harness, `/verify?token=${tokenFromMailbox()}`)
    const signedIn = await post(harness, '/auth/sign-in', { email, password })
    expect(signedIn.headers.getSetCookie().join('; '))
      .toContain(`Max-Age=${String(DEFAULT_SIGN_IN_TTL_MS / 1000)}`)

    nowMs += 13 * DAY_MS
    const slid = await request(harness, '/auth/me')
    expect(slid.json).toEqual({ ok: true, signedIn: true, email })
    expect(slid.headers.getSetCookie().join('; '))
      .toContain(`Max-Age=${String(DEFAULT_SIGN_IN_TTL_MS / 1000)}`)

    nowMs += 13 * DAY_MS
    expect((await request(harness, '/auth/me')).json).toEqual({ ok: true, signedIn: true, email })

    nowMs += DEFAULT_SIGN_IN_TTL_MS + 1
    expect((await request(harness, '/auth/me')).json).toEqual({ ok: true, signedIn: false })
  })

  it('ends a Sign-in session that sits idle past 14 days', { timeout: 60_000 }, async () => {
    const harness = await boot()
    const email = 'idle@example.com'
    const password = 'correct-horse'
    await post(harness, '/auth/register', { email, password })
    await request(harness, `/verify?token=${tokenFromMailbox()}`)
    await post(harness, '/auth/sign-in', { email, password })
    nowMs += DEFAULT_SIGN_IN_TTL_MS + 1
    expect((await request(harness, '/auth/me')).json).toEqual({ ok: true, signedIn: false })
    expect(harness.jar.hasSignIn()).toBe(true)
  })
})
