/**
 * Sign-in cookie name, Cookie-header parse, and the per-request Account id
 * for Host `/api` isolation.
 * @module @deepseek-ai/dsh-account/request
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { AccountId } from './types.ts'

/** Cookie name holding the Sign-in session id. Not a product name. */
export const SIGN_IN_COOKIE = 'dsh_sign_in'

const accountAls = new AsyncLocalStorage<AccountId>()

/**
 * Read one cookie value.
 * @param header - Cookie header.
 * @param cookieName - cookie name.
 * @returns the value, or `undefined` when absent.
 */
export function cookieValue(header: string | undefined, cookieName: string): string | undefined {
  if (header === undefined || header === '') return undefined
  for (const part of header.split(';')) {
    const trimmed = part.trim()
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    if (trimmed.slice(0, eq) === cookieName) {
      try {
        return decodeURIComponent(trimmed.slice(eq + 1))
      } catch {
        return undefined
      }
    }
  }
  return undefined
}

/**
 * Run `fn` with the signed-in Account as the current `/api` viewer.
 * @param accountId - owning Account, or `undefined` to leave the store unset.
 * @param fn - work that should observe {@link currentAccountId}.
 * @returns `fn`'s return value.
 */
export function runWithAccount<T>(accountId: AccountId | undefined, fn: () => T): T {
  if (accountId === undefined) return fn()
  return accountAls.run(accountId, fn)
}

/**
 * Account id bound by {@link runWithAccount} for this async chain.
 * @returns the signed-in Account, or `undefined` when none is bound.
 */
export function currentAccountId(): AccountId | undefined {
  return accountAls.getStore()
}
