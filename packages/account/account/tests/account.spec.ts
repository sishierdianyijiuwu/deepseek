import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import {
  accountId,
  cookieValue,
  currentAccountId,
  currentOperatorAccess,
  equalSecretHash,
  hashPassword,
  hashSecret,
  mintSecret,
  normalizeEmail,
  runWithAccount,
  runWithOperatorAccess,
  SIGN_IN_COOKIE,
  signInSessionId,
  verifyPassword,
  viewingAccountId,
} from '../src/index.ts'
import * as AccountInvariant from '../src/invariant.ts'

describe('email', () => {
  it('normalizes valid addresses and rejects the rest', () => {
    expect(normalizeEmail('  A.B@Example.COM ')).toBe('a.b@example.com')
    expect(normalizeEmail('')).toBeUndefined()
    expect(normalizeEmail('a'.repeat(255))).toBeUndefined()
    expect(normalizeEmail('no-at')).toBeUndefined()
    expect(normalizeEmail('@x.com')).toBeUndefined()
    expect(normalizeEmail('a@')).toBeUndefined()
    expect(normalizeEmail('a@localhost')).toBeUndefined()
    expect(normalizeEmail('.a@x.com')).toBeUndefined()
    expect(normalizeEmail('a.@x.com')).toBeUndefined()
    expect(normalizeEmail('a..b@x.com')).toBeUndefined()
    expect(normalizeEmail('a b@x.com')).toBeUndefined()
    expect(normalizeEmail('a@-x.com')).toBeUndefined()
    expect(normalizeEmail(`${'a'.repeat(65)}@x.com`)).toBeUndefined()
  })
})

describe('password', () => {
  it('round-trips a Password and rejects a malformed stored hash', async () => {
    const stored = await hashPassword('secret-password')
    await expect(verifyPassword('secret-password', stored)).resolves.toBe(true)
    await expect(verifyPassword('other', stored)).resolves.toBe(false)
    await expect(verifyPassword('secret-password', 'not-a-hash')).resolves.toBe(false)
    await expect(verifyPassword('secret-password', 'scrypt$1$1$1$zz$zz')).resolves.toBe(false)
    await expect(verifyPassword('secret-password', 'scrypt$x$1$1$aa$bb')).resolves.toBe(false)
    await expect(verifyPassword('secret-password', 'scrypt$16384$8$1$$00')).resolves.toBe(false)
    await expect(verifyPassword('secret-password', 'scrypt$16384$8$1$00$')).resolves.toBe(false)
    await expect(verifyPassword('secret-password', 'scrypt$16384$8$1$0$00')).resolves.toBe(false)
    await expect(verifyPassword('secret-password', 'scrypt$3$8$1$00aa$00bb')).resolves.toBe(false)
  })
})

describe('secret', () => {
  it('mints unique secrets and compares hashes in constant time', () => {
    const first = mintSecret()
    const second = mintSecret()
    expect(first.raw).not.toBe(second.raw)
    expect(hashSecret(first.raw)).toBe(first.hash)
    expect(equalSecretHash(first.hash, first.hash)).toBe(true)
    expect(equalSecretHash(first.hash, second.hash)).toBe(false)
    expect(equalSecretHash('', '')).toBe(false)
    expect(equalSecretHash('ab', 'abcd')).toBe(false)
    expect(equalSecretHash('zz', 'yy')).toBe(false)
    expect(equalSecretHash('aa', 'bb')).toBe(false)
  })
})

describe('ids', () => {
  it('brands Account and Sign-in session ids', () => {
    expect(accountId('a1')).toBe('a1')
    expect(signInSessionId('s1')).toBe('s1')
  })
})

describe('request Account', () => {
  it('parses the Sign-in cookie and binds the Account for one async chain', () => {
    expect(cookieValue(undefined, SIGN_IN_COOKIE)).toBeUndefined()
    expect(cookieValue(`${SIGN_IN_COOKIE}=tok`, SIGN_IN_COOKIE)).toBe('tok')
    expect(currentAccountId()).toBeUndefined()
    const seen = runWithAccount(accountId('a1'), () => currentAccountId())
    expect(seen).toBe('a1')
    expect(currentAccountId()).toBeUndefined()
    expect(runWithAccount(undefined, () => currentAccountId())).toBeUndefined()
  })

  it('keeps Operator access distinct from the signed-in Account', () => {
    const operator = accountId('ops')
    const target = accountId('user')
    const seen = runWithOperatorAccess({
      operatorAccountId: operator,
      operatorEmail: 'ops@example.com',
      targetAccountId: target,
    }, () => ({
      account: currentAccountId(),
      viewing: viewingAccountId(),
      access: currentOperatorAccess(),
      nested: runWithAccount(operator, () => viewingAccountId()),
    }))
    expect(seen).toEqual({
      account: operator,
      viewing: target,
      access: {
        operatorAccountId: operator,
        operatorEmail: 'ops@example.com',
        targetAccountId: target,
      },
      nested: target,
    })
    expect(viewingAccountId()).toBeUndefined()
  })
})

describe('invariant companion', () => {
  it('registers the package ownership with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(AccountInvariant).await()).resolves.toBeDefined()
  })
})
