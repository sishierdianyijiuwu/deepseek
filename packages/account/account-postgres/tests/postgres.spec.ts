import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { Mailer, type MailMessage } from '@deepseek-ai/dsh-mailer'
import PostgresAccounts from '../src/index.ts'
import { ensureSchema, SCHEMA_VERSION } from '../src/schema.ts'
import { isUniqueViolation, openSql } from '../src/sql.ts'
import * as PostgresInvariant from '../src/invariant.ts'

const mailbox: MailMessage[] = []

afterEach(() => {
  vi.restoreAllMocks()
})

class SilentMailer extends Mailer {
  override async send(message: MailMessage): Promise<void> {
    mailbox.push(message)
  }
}

describe('sql adapter', () => {
  it('rejects a non-postgres URL and reports unique-violation codes', async () => {
    await expect(openSql('mysql://x')).rejects.toThrow(/postgres:\/\//)
    expect(isUniqueViolation({ code: '23505' })).toBe(true)
    expect(isUniqueViolation({ code: '23503' })).toBe(false)
    expect(isUniqueViolation(null)).toBe(false)
    expect(isUniqueViolation('x')).toBe(false)
  })

  it('opens PGlite, migrates, nests a transaction, and refuses a foreign schema', { timeout: 20_000 }, async () => {
    const sql = await openSql('pglite:')
    await ensureSchema(sql)
    await ensureSchema(sql)
    expect(SCHEMA_VERSION).toBe(2)
    const nested = await sql.transaction(async (inner) => {
      await inner.close()
      await inner.transaction(async nestedInner => nestedInner.query('SELECT 1 AS x'))
      return sql.transaction(async () => {
        const ping = await inner.query('SELECT 1 AS x')
        return ping.rows[0]?.['x']
      })
    })
    expect(nested).toBe(1)
    await sql.query('UPDATE account_schema SET version = 99')
    await expect(ensureSchema(sql)).rejects.toThrow(/schema version 99/)
    await sql.close()
  })
})

describe('postgres accounts', () => {
  it('fails loud without url/publicBaseUrl and before start', async () => {
    expect(() => new PostgresAccounts(new Context(), { url: '', publicBaseUrl: 'http://x' }))
      .toThrow(/url and publicBaseUrl/)
    expect(() => new PostgresAccounts(new Context(), { url: 'pglite:', publicBaseUrl: '' }))
      .toThrow(/url and publicBaseUrl/)
    const ctx = new Context()
    const accounts = new PostgresAccounts(ctx, { url: 'pglite:', publicBaseUrl: 'http://127.0.0.1' })
    await expect(accounts.register('a@example.com', 'password12')).rejects.toThrow(/not started/)
  })

  it('starts, signs in, expires a Sign-in session, and disposes', { timeout: 30_000 }, async () => {
    mailbox.length = 0
    const ctx = new Context()
    await ctx.plugin(SilentMailer).await()
    await ctx.plugin(PostgresAccounts, {
      url: 'pglite:',
      publicBaseUrl: 'http://example.test',
      signInTtlMs: 20,
    }).await()
    const accounts = ctx.accounts
    await accounts.register('owner@example.com', 'password12')
    const token = /token=([0-9a-f]+)/.exec(mailbox[0]?.text ?? '')?.[1]
    expect(token).toBeDefined()
    await expect(accounts.verifyEmail(token!)).resolves.toEqual({ ok: true })
    const signedIn = await accounts.signIn('owner@example.com', 'password12')
    expect(signedIn.ok).toBe(true)
    if (!signedIn.ok) return
    await new Promise(resolve => setTimeout(resolve, 30))
    await expect(accounts.lookupSignIn(signedIn.signInId)).resolves.toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('slides a live Sign-in session and reset ends every session', { timeout: 30_000 }, async () => {
    mailbox.length = 0
    let nowMs = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs)
    const ctx = new Context()
    await ctx.plugin(SilentMailer).await()
    await ctx.plugin(PostgresAccounts, {
      url: 'pglite:',
      publicBaseUrl: 'http://example.test',
      signInTtlMs: 100,
      passwordResetTtlMs: 50,
    }).await()
    const accounts = ctx.accounts
    await accounts.register('owner@example.com', 'password12')
    const verifyToken = /token=([0-9a-f]+)/.exec(mailbox[0]?.text ?? '')?.[1]
    expect(verifyToken).toBeDefined()
    await expect(accounts.verifyEmail(verifyToken!)).resolves.toEqual({ ok: true })

    const first = await accounts.signIn('owner@example.com', 'password12')
    const second = await accounts.signIn('owner@example.com', 'password12')
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    nowMs += 80
    const slid = await accounts.lookupSignIn(first.signInId)
    expect(slid?.expiresAt).toBe(nowMs + 100)
    nowMs += 80
    await expect(accounts.lookupSignIn(first.signInId)).resolves.toMatchObject({ email: 'owner@example.com' })

    await accounts.requestPasswordReset('nobody@example.com')
    await accounts.requestPasswordReset('owner@example.com')
    const resetToken = /\/reset\?token=([0-9a-f]+)/.exec(mailbox.at(-1)?.text ?? '')?.[1]
    expect(resetToken).toBeDefined()
    await expect(accounts.resetPassword(resetToken!, 'short')).resolves.toEqual({
      ok: false,
      error: 'invalid_password',
    })
    await expect(accounts.resetPassword(resetToken!, 'password99')).resolves.toEqual({ ok: true })
    await expect(accounts.lookupSignIn(first.signInId)).resolves.toBeUndefined()
    await expect(accounts.lookupSignIn(second.signInId)).resolves.toBeUndefined()
    await expect(accounts.signIn('owner@example.com', 'password12')).resolves.toEqual({
      ok: false,
      error: 'invalid_credentials',
    })
    await expect(accounts.resetPassword(resetToken!, 'password99')).resolves.toEqual({
      ok: false,
      error: 'invalid_or_expired',
    })
    await expect(accounts.resetPassword('', 'password99')).resolves.toEqual({
      ok: false,
      error: 'invalid_or_expired',
    })
    await ctx.fiber.dispose()
  })
})

describe('invariant companion', () => {
  it('registers the package ownership with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(PostgresInvariant).await()).resolves.toBeDefined()
  })
})
