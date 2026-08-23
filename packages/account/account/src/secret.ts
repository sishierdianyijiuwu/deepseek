/**
 * Unguessable secrets (verification tokens, Sign-in session ids) stored as SHA-256.
 * @module @deepseek-ai/dsh-account/secret
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** Raw secret length in bytes (hex-encoded on the wire). */
const SECRET_BYTES = 32

/**
 * Mint a raw secret and its durable hash.
 * @returns the hex raw secret (to put in a cookie or mail) and the SHA-256 hex hash (to store).
 */
export function mintSecret(): { raw: string; hash: string } {
  const raw = randomBytes(SECRET_BYTES).toString('hex')
  return { raw, hash: hashSecret(raw) }
}

/**
 * Hash a raw secret for durable lookup.
 * @param raw - hex-encoded secret as issued to the browser or mailbox.
 * @returns SHA-256 hex digest.
 */
export function hashSecret(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

/**
 * Compare two hex hashes in constant time. Different lengths never match.
 * @param left - one digest.
 * @param right - the other digest.
 * @returns whether both are equal hex strings of the same length.
 */
export function equalSecretHash(left: string, right: string): boolean {
  if (left.length !== right.length || left.length === 0 || left.length % 2 !== 0) return false
  const a = Buffer.from(left, 'hex')
  const b = Buffer.from(right, 'hex')
  if (a.length !== b.length || a.length === 0) return false
  return timingSafeEqual(a, b)
}
