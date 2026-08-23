import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { accountId } from '@deepseek-ai/dsh-account'
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
    await expect(openSql('mysql://x', 'workspace-cloud')).rejects.toThrow(/workspace-cloud/)
    expect(isUniqueViolation({ code: '23505' })).toBe(true)
    expect(isUniqueViolation({ code: '23503' })).toBe(false)
    expect(isUniqueViolation(null)).toBe(false)
    expect(isUniqueViolation('x')).toBe(false)
  })

  it('opens a directory-backed PGlite url', { timeout: 20_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-pglite-'))
    const sql = await openSql(`pglite:${dir}`)
    expect((await sql.query('SELECT 1 AS n')).rows[0]?.['n']).toBe(1)
    await sql.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('opens PGlite, migrates, nests a transaction, and refuses a foreign schema', { timeout: 20_000 }, async () => {
    const sql = await openSql('pglite:')
    await ensureSchema(sql)
    await ensureSchema(sql)
    expect(SCHEMA_VERSION).toBe(5)
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
    expect(() => new PostgresAccounts(new Context(), {
      url: 'pglite:',
      publicBaseUrl: 'http://x',
      operatorEmails: ['not-an-email'],
    })).toThrow(/operatorEmails contains an invalid email/)
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
    await expect(accounts.lookupSignIn(first.signInId)).resolves.toMatchObject({
      email: 'owner@example.com',
      operator: false,
    })

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

  it('lets only one concurrent resetPassword consume the token', { timeout: 30_000 }, async () => {
    mailbox.length = 0
    const ctx = new Context()
    await ctx.plugin(SilentMailer).await()
    await ctx.plugin(PostgresAccounts, {
      url: 'pglite:',
      publicBaseUrl: 'http://example.test',
    }).await()
    const accounts = ctx.accounts
    await accounts.register('race@example.com', 'password12')
    const verifyToken = /token=([0-9a-f]+)/.exec(mailbox[0]?.text ?? '')?.[1]
    expect(verifyToken).toBeDefined()
    await accounts.verifyEmail(verifyToken!)
    await accounts.requestPasswordReset('race@example.com')
    const resetToken = /\/reset\?token=([0-9a-f]+)/.exec(mailbox.at(-1)?.text ?? '')?.[1]
    expect(resetToken).toBeDefined()
    const concurrent = await Promise.all([
      accounts.resetPassword(resetToken!, 'password99'),
      accounts.resetPassword(resetToken!, 'password88'),
    ])
    const outcomes = concurrent.map(row => row.ok ? 'ok' : row.error)
    expect(outcomes.sort()).toEqual(['invalid_or_expired', 'ok'])
    const winner = concurrent.find(row => row.ok)
    expect(winner).toBeDefined()
    await ctx.fiber.dispose()
  })

  it('looks up Accounts without Session bodies and appends Operator audit rows', { timeout: 30_000 }, async () => {
    mailbox.length = 0
    const ctx = new Context()
    await ctx.plugin(SilentMailer).await()
    await ctx.plugin(PostgresAccounts, {
      url: 'pglite:',
      publicBaseUrl: 'http://example.test',
      operatorEmails: ['ops@example.com'],
    }).await()
    const accounts = ctx.accounts
    await accounts.register('user@example.com', 'password12')
    const unverified = await accounts.lookupByEmail('user@example.com')
    expect(unverified).toMatchObject({ email: 'user@example.com', verified: false, banned: false })
    expect(unverified?.accountId).toEqual(expect.any(String))
    const token = /token=([0-9a-f]+)/.exec(mailbox[0]?.text ?? '')?.[1]
    expect(token).toBeDefined()
    await accounts.verifyEmail(token!)
    await expect(accounts.lookupByEmail('user@example.com')).resolves.toMatchObject({
      email: 'user@example.com',
      verified: true,
      banned: false,
    })
    await accounts.ban('user@example.com')
    const banned = await accounts.lookupByEmail('user@example.com')
    expect(banned?.banned).toBe(true)
    expect(await accounts.lookupById(banned!.accountId)).toEqual(banned)
    await expect(accounts.lookupByEmail('missing@example.com')).resolves.toBeUndefined()

    const recorded = await accounts.recordOperatorAccess({
      operatorAccountId: accountId('ops-1'),
      operatorEmail: 'ops@example.com',
      targetAccountId: banned!.accountId,
      sessionId: 'session-1',
      openedAt: 1_700_000_000_000,
    })
    expect(recorded.id).toEqual(expect.any(String))
    expect(await accounts.listOperatorAccess()).toEqual([recorded])
    await ctx.fiber.dispose()
  })

  it('deletes the Account row so the email can register again and leaves others', { timeout: 30_000 }, async () => {
    mailbox.length = 0
    const ctx = new Context()
    await ctx.plugin(SilentMailer).await()
    await ctx.plugin(PostgresAccounts, {
      url: 'pglite:',
      publicBaseUrl: 'http://example.test',
    }).await()
    const accounts = ctx.accounts
    await accounts.register('keep@example.com', 'password12')
    const keepToken = /token=([0-9a-f]+)/.exec(mailbox[0]?.text ?? '')?.[1]
    expect(keepToken).toBeDefined()
    await accounts.verifyEmail(keepToken!)
    await accounts.register('gone@example.com', 'password12')
    const goneToken = /token=([0-9a-f]+)/.exec(mailbox.at(-1)?.text ?? '')?.[1]
    expect(goneToken).toBeDefined()
    await accounts.verifyEmail(goneToken!)
    const signedIn = await accounts.signIn('gone@example.com', 'password12')
    expect(signedIn.ok).toBe(true)
    if (!signedIn.ok) return
    const gone = await accounts.lookupByEmail('gone@example.com')
    expect(gone).toBeDefined()
    await expect(accounts.deleteAccount(gone!.accountId)).resolves.toEqual({ ok: true })
    await expect(accounts.lookupSignIn(signedIn.signInId)).resolves.toBeUndefined()
    await expect(accounts.lookupByEmail('gone@example.com')).resolves.toBeUndefined()
    await expect(accounts.deleteAccount(gone!.accountId)).resolves.toEqual({ ok: false, error: 'not_found' })
    await expect(accounts.register('gone@example.com', 'password12')).resolves.toEqual({ ok: true })
    expect(await accounts.lookupByEmail('keep@example.com')).toMatchObject({
      email: 'keep@example.com',
      verified: true,
    })
    await ctx.fiber.dispose()
  })

  it('rethrows a register failure that is not a unique violation', { timeout: 30_000 }, async () => {
    mailbox.length = 0
    const ctx = new Context()
    await ctx.plugin(SilentMailer).await()
    await ctx.plugin(PostgresAccounts, {
      url: 'pglite:',
      publicBaseUrl: 'http://example.test',
    }).await()
    const impl = ctx.accounts as unknown as {
      client: () => {
        query: () => Promise<{ rows: unknown[] }>
        transaction: (fn: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(impl, 'client').mockReturnValue({
      query: () => Promise.resolve({ rows: [] }),
      transaction: () => Promise.reject(new Error('disk')),
    })
    await expect(ctx.accounts.register('boom@example.com', 'password12')).rejects.toThrow('disk')
    await ctx.fiber.dispose()
  })

  it('refuses register when freeze commits after the cheap check', { timeout: 30_000 }, async () => {
    mailbox.length = 0
    const ctx = new Context()
    await ctx.plugin(SilentMailer).await()
    await ctx.plugin(PostgresAccounts, {
      url: 'pglite:',
      publicBaseUrl: 'http://example.test',
    }).await()
    await ctx.accounts.setRegistrationFrozen(true)
    vi.spyOn(PostgresAccounts.prototype, 'isRegistrationFrozen').mockResolvedValue(false)
    await expect(ctx.accounts.register('late@example.com', 'password12'))
      .resolves.toEqual({ ok: false, error: 'registration_frozen' })
    await ctx.fiber.dispose()
  })

  it('charges sandbox-running intervals per UTC day and ignores a missing end', {
    timeout: 30_000,
  }, async () => {
    mailbox.length = 0
    const nowMs = Date.parse('2026-01-01T23:30:00.000Z')
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs)
    const ctx = new Context()
    await ctx.plugin(SilentMailer).await()
    await ctx.plugin(PostgresAccounts, {
      url: 'pglite:',
      publicBaseUrl: 'http://example.test',
    }).await()
    const accounts = ctx.accounts
    await accounts.register('cap@example.com', 'password12')
    const token = /token=([0-9a-f]+)/.exec(mailbox[0]?.text ?? '')?.[1]
    expect(token).toBeDefined()
    await accounts.verifyEmail(token!)
    const owner = await accounts.lookupByEmail('cap@example.com')
    expect(owner).toBeDefined()
    const id = owner!.accountId

    expect(await accounts.executingWorldUsedMs(id, nowMs)).toBe(0)
    await accounts.endExecutingWorld(id, nowMs, nowMs)
    expect(await accounts.executingWorldUsedMs(id, nowMs)).toBe(0)

    await expect(accounts.beginExecutingWorld(id, nowMs)).resolves.toBe(nowMs)
    expect(await accounts.executingWorldUsedMs(id, nowMs)).toBe(0)
    const nextDay = Date.parse('2026-01-02T00:30:00.000Z')
    expect(await accounts.executingWorldUsedMs(id, nextDay)).toBe(30 * 60_000)
    await accounts.endExecutingWorld(id, nowMs, nextDay)
    expect(await accounts.executingWorldUsedMs(id, nowMs)).toBe(30 * 60_000)
    expect(await accounts.executingWorldUsedMs(id, nextDay)).toBe(30 * 60_000)

    await accounts.beginExecutingWorld(id, nextDay)
    await accounts.endExecutingWorld(id, nextDay, nextDay - 1)
    expect(await accounts.executingWorldUsedMs(id, nextDay)).toBe(30 * 60_000)

    await accounts.beginExecutingWorld(id, nextDay)
    const later = nextDay + 10_000
    await accounts.beginExecutingWorld(id, later)
    expect(await accounts.executingWorldUsedMs(id, later)).toBe(30 * 60_000 + 10_000)
    await accounts.endExecutingWorld(id, nextDay, later + 5_000)
    expect(await accounts.executingWorldUsedMs(id, later)).toBe(30 * 60_000 + 10_000)
    await accounts.endExecutingWorld(id, later, later + 5_000)
    expect(await accounts.executingWorldUsedMs(id, later)).toBe(30 * 60_000 + 15_000)

    await expect(accounts.deleteAccount(id)).resolves.toEqual({ ok: true })
    await ctx.fiber.dispose()
  })

  it('closes leftover open intervals when the provider starts', { timeout: 30_000 }, async () => {
    mailbox.length = 0
    const dir = await mkdtemp(join(tmpdir(), 'dsh-e2b-cap-'))
    let nowMs = Date.parse('2026-01-15T12:00:00.000Z')
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs)
    const url = `pglite:${dir}`
    const first = new Context()
    await first.plugin(SilentMailer).await()
    await first.plugin(PostgresAccounts, { url, publicBaseUrl: 'http://example.test' }).await()
    await first.accounts.register('cap@example.com', 'password12')
    const token = /token=([0-9a-f]+)/.exec(mailbox[0]?.text ?? '')?.[1]
    expect(token).toBeDefined()
    await first.accounts.verifyEmail(token!)
    const owner = await first.accounts.lookupByEmail('cap@example.com')
    expect(owner).toBeDefined()
    await first.accounts.beginExecutingWorld(owner!.accountId, nowMs)
    await first.fiber.dispose()

    nowMs += 12_000
    const second = new Context()
    await second.plugin(SilentMailer).await()
    await second.plugin(PostgresAccounts, { url, publicBaseUrl: 'http://example.test' }).await()
    expect(await second.accounts.executingWorldUsedMs(owner!.accountId, nowMs)).toBe(12_000)
    await second.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  it('splits a leftover open interval across UTC midnight on provider start', {
    timeout: 30_000,
  }, async () => {
    mailbox.length = 0
    const dir = await mkdtemp(join(tmpdir(), 'dsh-e2b-cap-midnight-'))
    let nowMs = Date.parse('2026-01-01T23:30:00.000Z')
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs)
    const url = `pglite:${dir}`
    const first = new Context()
    await first.plugin(SilentMailer).await()
    await first.plugin(PostgresAccounts, { url, publicBaseUrl: 'http://example.test' }).await()
    await first.accounts.register('cap@example.com', 'password12')
    const token = /token=([0-9a-f]+)/.exec(mailbox[0]?.text ?? '')?.[1]
    expect(token).toBeDefined()
    await first.accounts.verifyEmail(token!)
    const owner = await first.accounts.lookupByEmail('cap@example.com')
    expect(owner).toBeDefined()
    await first.accounts.beginExecutingWorld(owner!.accountId, nowMs)
    await first.fiber.dispose()

    nowMs = Date.parse('2026-01-02T00:30:00.000Z')
    const second = new Context()
    await second.plugin(SilentMailer).await()
    await second.plugin(PostgresAccounts, { url, publicBaseUrl: 'http://example.test' }).await()
    expect(await second.accounts.executingWorldUsedMs(owner!.accountId, Date.parse('2026-01-01T23:59:00.000Z')))
      .toBe(30 * 60_000)
    expect(await second.accounts.executingWorldUsedMs(owner!.accountId, nowMs)).toBe(30 * 60_000)
    await second.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  })
})

describe('invariant companion', () => {
  it('registers the package ownership with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(PostgresInvariant).await()).resolves.toBeDefined()
  })
})
