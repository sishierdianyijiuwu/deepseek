/**
 * Sign-in cookie name, Cookie-header parse, and the per-request Account id
 * for Host `/api` isolation, including read-only Operator access.
 * @module @deepseek-ai/dsh-account/request
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { AccountId, OperatorAccess } from './types.ts'

/** Cookie name holding the Sign-in session id. Not a product name. */
export const SIGN_IN_COOKIE = 'dsh_sign_in'

/**
 * HTTP header naming the Account email an Operator is opening read-only.
 * Lower-case as Node serves incoming header names.
 */
export const OPERATOR_ACCESS_HEADER = 'x-dsh-operator-access'

interface BoundViewer {
  accountId: AccountId
  operatorAccess?: Omit<OperatorAccess, 'operatorAccountId'>
}

const accountAls = new AsyncLocalStorage<BoundViewer>()

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
 * Nested calls keep an outer {@link runWithOperatorAccess} target.
 * @param accountId - owning Account, or `undefined` to leave the store unset.
 * @param fn - work that should observe {@link currentAccountId}.
 * @returns `fn`'s return value.
 */
export function runWithAccount<T>(accountId: AccountId | undefined, fn: () => T): T {
  if (accountId === undefined) return fn()
  const parent = accountAls.getStore()
  return accountAls.run({
    accountId,
    ...parent?.operatorAccess === undefined ? {} : { operatorAccess: parent.operatorAccess },
  }, fn)
}

/**
 * Run `fn` as an Operator viewing `access.targetAccountId` read-only.
 * {@link currentAccountId} stays the Operator; {@link viewingAccountId} is the
 * target. Credential resolution still uses the Operator and Host writes refuse.
 * @param access - Operator and target Account.
 * @param fn - `/api` work that should see the target's Sessions and files.
 * @returns `fn`'s return value.
 */
export function runWithOperatorAccess<T>(access: OperatorAccess, fn: () => T): T {
  return accountAls.run({
    accountId: access.operatorAccountId,
    operatorAccess: {
      targetAccountId: access.targetAccountId,
      operatorEmail: access.operatorEmail,
    },
  }, fn)
}

/**
 * Account id bound by {@link runWithAccount} for this async chain.
 * Under Operator access this is the Operator, never the target.
 * @returns the signed-in Account, or `undefined` when none is bound.
 */
export function currentAccountId(): AccountId | undefined {
  return accountAls.getStore()?.accountId
}

/**
 * Operator-access target bound by {@link runWithOperatorAccess}.
 * @returns the opening, or `undefined` when this chain is not Operator access.
 */
export function currentOperatorAccess(): OperatorAccess | undefined {
  const store = accountAls.getStore()
  if (store?.operatorAccess === undefined) return undefined
  return {
    operatorAccountId: store.accountId,
    targetAccountId: store.operatorAccess.targetAccountId,
    operatorEmail: store.operatorAccess.operatorEmail,
  }
}

/**
 * Account whose Sessions and Workspace files this `/api` chain may read.
 * @returns the Operator-access target, else {@link currentAccountId}.
 */
export function viewingAccountId(): AccountId | undefined {
  return currentOperatorAccess()?.targetAccountId ?? currentAccountId()
}
