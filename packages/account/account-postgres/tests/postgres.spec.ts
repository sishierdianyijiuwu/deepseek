import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { Mailer, type MailMessage } from '@deepseek-ai/dsh-mailer'
import PostgresAccounts from '../src/index.ts'
import { ensureSchema, SCHEMA_VERSION } from '../src/schema.ts'
import { isUniqueViolation, openSql } from '../src/sql.ts'
import * as PostgresInvariant from '../src/invariant.ts'

const mailbox: MailMessage[] = []

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
    expect(SCHEMA_VERSION).toBe(1)
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
})

describe('invariant companion', () => {
  it('registers the package ownership with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(PostgresInvariant).await()).resolves.toBeDefined()
  })
})
