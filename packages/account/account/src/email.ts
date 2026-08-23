/**
 * Email normalization for Account identity.
 * @module @deepseek-ai/dsh-account/email
 */

/** Maximum accepted email length (RFC 5321). */
const MAX_EMAIL_LENGTH = 254

/**
 * Trim, lowercase, and reject values that cannot be an email address.
 * @param raw - visitor-supplied email.
 * @returns the normalized email, or `undefined` when it is not usable as an Account identity.
 */
export function normalizeEmail(raw: string): string | undefined {
  const email = raw.trim().toLowerCase()
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH) return undefined
  const at = email.lastIndexOf('@')
  if (at <= 0 || at === email.length - 1) return undefined
  const local = email.slice(0, at)
  const domain = email.slice(at + 1)
  if (local.length === 0 || local.length > 64 || !domain.includes('.')) return undefined
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return undefined
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)) return undefined
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain)) {
    return undefined
  }
  return email
}
