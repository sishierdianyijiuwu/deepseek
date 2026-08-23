/**
 * Per-Account isolation of the hosted credentials provider. HTTP with two
 * cookie jars is the source of truth; this pins resolve/set without a restart.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  Accounts,
  accountId,
  runWithAccount,
  type RegisterResult,
  type ResetPasswordResult,
  type SignInLookup,
  type SignInResult,
  type SignInSessionId,
  type VerifyEmailResult,
} from '@deepseek-ai/dsh-account'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import { AccountCredentialProvider, ACCOUNT_SOURCE, resolveSpec } from '../src/index.ts'

const KEY = credentialRef('DEEPSEEK_API_KEY')
const OTHER = credentialRef('OPENAI_API_KEY')
const accountA = accountId('account-a')
const accountB = accountId('account-b')

class FakeAccounts extends Accounts {
  override register(): Promise<RegisterResult> {
    return Promise.resolve({ ok: true })
  }
  override verifyEmail(): Promise<VerifyEmailResult> {
    return Promise.resolve({ ok: true })
  }
  override resendVerification(): Promise<void> {
    return Promise.resolve()
  }
  override signIn(): Promise<SignInResult> {
    return Promise.resolve({ ok: false, error: 'invalid_credentials' })
  }
  override signOut(_signInId: SignInSessionId): Promise<void> {
    return Promise.resolve()
  }
  override lookupSignIn(_signInId: SignInSessionId): Promise<SignInLookup | undefined> {
    return Promise.resolve(undefined)
  }
  override requestPasswordReset(): Promise<void> {
    return Promise.resolve()
  }
  override resetPassword(): Promise<ResetPasswordResult> {
    return Promise.resolve({ ok: false, error: 'invalid_or_expired' })
  }
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-credentials-account-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function boot(dshHome: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(FakeAccounts)
  const fiber = ctx.plugin(AccountCredentialProvider, { dshHome })
  cleanups.push(async () => { await fiber.dispose() })
  await fiber
  return ctx
}

describe('resolveSpec', () => {
  it('places Account documents under the harness home credentials directory', () => {
    const spec = resolveSpec({ dshHome: '/custom/home' })
    expect(spec.directory).toBe(join('/custom/home', 'credentials'))
  })
})

describe('Account-scoped credentials', () => {
  it('scopes set/resolve to the bound Account and ignores process env', async () => {
    const dir = await tempDir()
    const previous = process.env['DEEPSEEK_API_KEY']
    process.env['DEEPSEEK_API_KEY'] = 'env-must-not-leak'
    try {
      const ctx = await boot(dir)
      expect(await ctx.credentials.resolve(KEY)).toBeUndefined()
      expect(await ctx.credentials.hasStoredSecret()).toBe(false)

      await runWithAccount(accountA, () => ctx.credentials.set(KEY, 'secret-a'))
      expect(await runWithAccount(accountA, () => ctx.credentials.resolve(KEY)))
        .toEqual({ value: 'secret-a', source: ACCOUNT_SOURCE })
      expect(await runWithAccount(accountB, () => ctx.credentials.resolve(KEY))).toBeUndefined()
      expect(await runWithAccount(accountB, () => ctx.credentials.describe(KEY)))
        .toEqual({ configured: false, writable: true })
      expect(await runWithAccount(accountA, () => ctx.credentials.hasStoredSecret())).toBe(true)
      expect(await runWithAccount(accountB, () => ctx.credentials.hasStoredSecret())).toBe(false)

      await runWithAccount(accountB, () => ctx.credentials.set(KEY, 'secret-b'))
      expect(await runWithAccount(accountA, () => ctx.credentials.resolve(KEY)))
        .toEqual({ value: 'secret-a', source: ACCOUNT_SOURCE })
      expect(await runWithAccount(accountB, () => ctx.credentials.resolve(KEY)))
        .toEqual({ value: 'secret-b', source: ACCOUNT_SOURCE })
    } finally {
      if (previous === undefined) delete process.env['DEEPSEEK_API_KEY']
      else process.env['DEEPSEEK_API_KEY'] = previous
    }
  })

  it('applies a write to the next resolve without a restart', async () => {
    const ctx = await boot(await tempDir())
    await runWithAccount(accountA, () => ctx.credentials.set(KEY, 'first'))
    await runWithAccount(accountA, () => ctx.credentials.set(KEY, 'second'))
    expect(await runWithAccount(accountA, () => ctx.credentials.resolve(KEY)))
      .toEqual({ value: 'second', source: ACCOUNT_SOURCE })
    await runWithAccount(accountA, () => ctx.credentials.unset(KEY))
    expect(await runWithAccount(accountA, () => ctx.credentials.resolve(KEY))).toBeUndefined()
    expect(await runWithAccount(accountA, () => ctx.credentials.hasStoredSecret())).toBe(false)
  })

  it('refuses writes without a signed-in Account and leaves reads unconfigured', async () => {
    const ctx = await boot(await tempDir())
    await expect(ctx.credentials.set(KEY, 'x')).rejects.toThrow(/signed-in Account/)
    expect(await ctx.credentials.describe(KEY)).toEqual({ configured: false, writable: false })
    expect(await ctx.credentials.listRecords()).toEqual([])
  })

  it('keeps records isolated the same way as references', async () => {
    const ctx = await boot(await tempDir())
    const key = credentialKey('llm-pi-ai', 'openai-codex')
    await runWithAccount(accountA, () => ctx.credentials.modifyRecord(key, () => Promise.resolve({
      kind: 'api-key' as const,
      key: 'record-a',
    })))
    expect(await runWithAccount(accountA, () => ctx.credentials.readRecord(key)))
      .toEqual({ kind: 'api-key', key: 'record-a' })
    expect(await runWithAccount(accountB, () => ctx.credentials.readRecord(key))).toBeUndefined()
    expect(await runWithAccount(accountB, () => ctx.credentials.hasStoredSecret())).toBe(false)
    expect(await runWithAccount(accountA, () => ctx.credentials.hasStoredSecret())).toBe(true)
  })

  it('reloads a stored document after a new boot', async () => {
    const dir = await tempDir()
    const first = await boot(dir)
    await runWithAccount(accountA, () => first.credentials.set(KEY, 'durable'))
    await runWithAccount(accountA, () => first.credentials.set(OTHER, 'other-a'))
    const second = await boot(dir)
    expect(await runWithAccount(accountA, () => second.credentials.resolve(KEY)))
      .toEqual({ value: 'durable', source: ACCOUNT_SOURCE })
    expect(await runWithAccount(accountB, () => second.credentials.resolve(KEY))).toBeUndefined()
  })

  it('rejects an unreadable stored document rather than treating it as empty', async () => {
    const dir = await tempDir()
    const ctx = await boot(dir)
    await mkdir(join(dir, 'credentials'), { recursive: true, mode: 0o700 })
    await writeFile(join(dir, 'credentials', 'account-a.json'), '{not-json', { mode: 0o600 })
    await expect(runWithAccount(accountA, () => ctx.credentials.resolve(KEY))).rejects.toThrow(/invalid JSON/)
  })

  it('rejects an empty set and a write without a filename-safe Account id', async () => {
    const ctx = await boot(await tempDir())
    await expect(runWithAccount(accountA, () => ctx.credentials.set(KEY, ''))).rejects.toThrow(/empty value/)
    await expect(runWithAccount(accountId('bad/id'), () => ctx.credentials.set(KEY, 'x')))
      .rejects.toThrow(/cannot name a credentials document/)
    expect(await runWithAccount(accountId('bad/id'), () => ctx.credentials.hasStoredSecret())).toBe(false)
  })

  it('describes and lists records, including a declined mutation and a delete', async () => {
    const ctx = await boot(await tempDir())
    const key = credentialKey('llm-pi-ai', 'openai-codex')
    expect(await ctx.credentials.describeRecord(key)).toEqual({ configured: false, writable: false })
    expect(await runWithAccount(accountA, () => ctx.credentials.describeRecord(key)))
      .toEqual({ configured: false, writable: true })
    expect(await runWithAccount(accountA, () => ctx.credentials.listRecords())).toEqual([])
    await runWithAccount(accountA, () => ctx.credentials.modifyRecord(key, () => Promise.resolve({
      kind: 'grant' as const,
      payload: { token: 't' },
    })))
    expect(await runWithAccount(accountA, () => ctx.credentials.describeRecord(key)))
      .toEqual({ configured: true, kind: 'grant', writable: true })
    expect(await runWithAccount(accountA, () => ctx.credentials.listRecords()))
      .toEqual([{ key, kind: 'grant' }])
    const declined = await runWithAccount(accountA, () => ctx.credentials.modifyRecord(key, () => Promise.resolve(undefined)))
    expect(declined).toEqual({ kind: 'grant', payload: { token: 't' } })
    await runWithAccount(accountA, () => ctx.credentials.deleteRecord(key))
    expect(await runWithAccount(accountA, () => ctx.credentials.readRecord(key))).toBeUndefined()
    await runWithAccount(accountA, () => ctx.credentials.deleteRecord(key))
  })

  it('refuses an unstorable api-key or grant payload', async () => {
    const ctx = await boot(await tempDir())
    const key = credentialKey('llm-pi-ai', 'openai-codex')
    await expect(runWithAccount(accountA, () => ctx.credentials.modifyRecord(key, () => Promise.resolve({
      kind: 'api-key' as const,
      key: '',
    })))).rejects.toThrow(/empty key/)
    await expect(runWithAccount(accountA, () => ctx.credentials.modifyRecord(key, () => Promise.resolve({
      kind: 'api-key' as const,
      env: { AWS_PROFILE: '' },
    })))).rejects.toThrow(/must be a non-empty string/)
    await expect(runWithAccount(accountA, () => ctx.credentials.modifyRecord(key, () => Promise.resolve({
      kind: 'grant' as const,
      payload: { n: Number.NaN },
    })))).rejects.toThrow(/non-finite number/)
    await expect(runWithAccount(accountA, () => ctx.credentials.modifyRecord(key, () => Promise.resolve({
      kind: 'grant' as const,
      payload: { n: Number.POSITIVE_INFINITY },
    })))).rejects.toThrow(/non-finite number/)
    await expect(runWithAccount(accountA, () => ctx.credentials.modifyRecord(key, () => Promise.resolve({
      kind: 'api-key' as const,
      env: { 'NOT-POSIX': 'p' },
    })))).rejects.toThrow(TypeError)
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    await expect(runWithAccount(accountA, () => ctx.credentials.modifyRecord(key, () => Promise.resolve({
      kind: 'grant' as const,
      payload: cyclic,
    })))).rejects.toThrow(/cyclic/)
    await expect(runWithAccount(accountA, () => ctx.credentials.modifyRecord(key, () => Promise.resolve({
      kind: 'grant' as const,
      payload: { fn: () => 1 },
    })))).rejects.toThrow(/JSON cannot represent/)
    await expect(runWithAccount(accountA, () => ctx.credentials.modifyRecord(key, () => Promise.resolve({
      kind: 'grant' as const,
      payload: Object.create(null),
    })))).rejects.toThrow(/JSON cannot represent/)
  })

  it('treats a no-op unset as success', async () => {
    const ctx = await boot(await tempDir())
    await runWithAccount(accountA, () => ctx.credentials.unset(KEY))
    await runWithAccount(accountA, () => ctx.credentials.set(OTHER, 'keep'))
    await runWithAccount(accountA, () => ctx.credentials.unset(KEY))
    expect(await runWithAccount(accountA, () => ctx.credentials.resolve(OTHER)))
      .toEqual({ value: 'keep', source: ACCOUNT_SOURCE })
    expect(await runWithAccount(accountA, () => ctx.credentials.resolve(KEY))).toBeUndefined()
  })

  it('refuses writes after disposal and reads a closed cache-miss as unconfigured', async () => {
    const dir = await tempDir()
    const ctx = new Context()
    await ctx.plugin(FakeAccounts)
    const fiber = ctx.plugin(AccountCredentialProvider, { dshHome: dir })
    await fiber
    const service = ctx.credentials
    await fiber.dispose()
    await expect(runWithAccount(accountA, () => service.set(KEY, 'x')))
      .rejects.toThrow(/disposed/)
    await expect(runWithAccount(accountA, () => service.unset(KEY)))
      .rejects.toThrow(/disposed/)
    expect(await runWithAccount(accountA, () => service.resolve(KEY))).toBeUndefined()
    await expect(runWithAccount(accountA, () => service.modifyRecord(
      credentialKey('llm-pi-ai', 'openai-codex'),
      () => Promise.resolve({ kind: 'api-key' as const }),
    ))).rejects.toThrow(/disposed/)
    await expect(runWithAccount(accountA, () => service.deleteRecord(
      credentialKey('llm-pi-ai', 'openai-codex'),
    ))).rejects.toThrow(/disposed/)
  })

  it('surfaces a non-ENOENT read failure instead of an empty store', async () => {
    const dir = await tempDir()
    const ctx = await boot(dir)
    await mkdir(join(dir, 'credentials', 'account-a.json'), { recursive: true, mode: 0o700 })
    await expect(runWithAccount(accountA, () => ctx.credentials.resolve(KEY))).rejects.toThrow()
  })

  it('stores a JSON-safe grant and a finite numeric payload', async () => {
    const ctx = await boot(await tempDir())
    const key = credentialKey('llm-pi-ai', 'openai-codex')
    await runWithAccount(accountA, () => ctx.credentials.modifyRecord(key, () => Promise.resolve({
      kind: 'grant' as const,
      payload: 'raw-token',
    })))
    expect(await runWithAccount(accountA, () => ctx.credentials.readRecord(key)))
      .toEqual({ kind: 'grant', payload: 'raw-token' })
    await runWithAccount(accountA, () => ctx.credentials.modifyRecord(key, () => Promise.resolve({
      kind: 'grant' as const,
      payload: { n: 1, ok: true, nested: { a: [null, 'x'] } },
    })))
    expect(await runWithAccount(accountA, () => ctx.credentials.readRecord(key))).toEqual({
      kind: 'grant',
      payload: { n: 1, ok: true, nested: { a: [null, 'x'] } },
    })
    await runWithAccount(accountA, () => ctx.credentials.modifyRecord(key, () => Promise.resolve({
      kind: 'api-key' as const,
      env: { AWS_PROFILE: 'prod' },
    })))
    expect(await runWithAccount(accountA, () => ctx.credentials.readRecord(key)))
      .toEqual({ kind: 'api-key', env: { AWS_PROFILE: 'prod' } })
  })
})
