/**
 * One-way Password hashing for Accounts (scrypt). Never reversible, never a Credential.
 * @module @deepseek-ai/dsh-account/password
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'

/**
 * scrypt with explicit options. `promisify(scrypt)` drops the options overload.
 * @param password - Password bytes.
 * @param salt - salt bytes.
 * @param keylen - derived key length.
 * @param options - scrypt cost parameters.
 * @returns the derived key.
 */
function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (error, derived) => {
      /* v8 ignore next -- Node reports invalid scrypt params by throwing, not via this callback */
      if (error !== null) reject(error)
      else resolve(derived)
    })
  })
}

/** scrypt CPU/memory cost parameter. */
const N = 16_384
/** scrypt block size. */
const R = 8
/** scrypt parallelism. */
const P = 1
/** Derived key length in bytes. */
const KEY_LEN = 32
/** Salt length in bytes. */
const SALT_LEN = 16
/** Encoded scheme prefix so a later algorithm can coexist. */
const SCHEME = `scrypt$${String(N)}$${String(R)}$${String(P)}`

/**
 * Hash a Password for durable storage.
 * @param password - the Password in cleartext.
 * @returns the encoded one-way hash.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN)
  const key = await scrypt(password, salt, KEY_LEN, { N, r: R, p: P })
  return `${SCHEME}$${salt.toString('hex')}$${key.toString('hex')}`
}

/**
 * Compare a Password to a stored one-way hash without leaking which arm failed
 * through an early return before scrypt.
 * @param password - the Password in cleartext.
 * @param stored - the encoded hash from storage; malformed values never match.
 * @returns whether the Password matches.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const n = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  const saltHex = parts[4]
  const keyHex = parts[5]
  if (
    !Number.isInteger(n) || n <= 0
    || !Number.isInteger(r) || r <= 0
    || !Number.isInteger(p) || p <= 0
    || saltHex === undefined || keyHex === undefined
    || saltHex.length === 0 || keyHex.length === 0
    || saltHex.length % 2 !== 0 || keyHex.length % 2 !== 0
  ) return false
  const salt = Buffer.from(saltHex, 'hex')
  const expected = Buffer.from(keyHex, 'hex')
  if (salt.length === 0 || expected.length === 0) return false
  let actual: Buffer
  try {
    actual = await scrypt(password, salt, expected.length, { N: n, r, p })
  } catch {
    return false
  }
  /* v8 ignore next -- scrypt is asked for expected.length */
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}
