/**
 * Account gate plugin, browser half: occupies `shell.overlay` with register,
 * sign-in, verification notice, and sign-out. Auth HTTP lives beside `/api`.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { AccountGate } from './AccountGate.tsx'
import { en, zh, type AccountKey } from './locales.ts'

export type { AccountKey } from './locales.ts'
export type { AccountGateProps } from './AccountGate.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Register / sign-in / sign-out copy. */
    account: AccountKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'account'

/** JSON body from the auth HTTP routes. */
export type AuthResult =
  | { ok: true }
  | { ok: false; error: { code: string; message: string } }

/** Current Sign-in session as `/auth/me` reports it. */
export type MeResult =
  | { ok: true; signedIn: false }
  | { ok: true; signedIn: true; email: string }

/** Injected business face of the account overlay. */
export interface AccountGateInjected {
  /** GET `/auth/me`. */
  me: () => Promise<MeResult>
  /** POST `/auth/register`. */
  register: (email: string, password: string) => Promise<AuthResult>
  /** POST `/auth/sign-in`. */
  signIn: (email: string, password: string) => Promise<AuthResult>
  /** POST `/auth/sign-out`. */
  signOut: () => Promise<AuthResult>
  /** POST `/auth/resend-verification`. */
  resend: (email: string) => Promise<AuthResult>
  /** Current `location.search` (verification redirect query). */
  getSearch: () => string
  /** Drop the verification query after it has been shown. */
  replaceSearch: () => void
}

/** Required services: the overlay slot registry and locale registry. */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: register the Account gate over the auth HTTP routes.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-account: dictionaries')

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'account-gate',
    order: 0,
    locale: NS,
    inject: (): AccountGateInjected => ({
      me: () => getJson('/auth/me'),
      register: (email, password) => postJson('/auth/register', { email, password }),
      signIn: (email, password) => postJson('/auth/sign-in', { email, password }),
      signOut: () => postJson('/auth/sign-out', {}),
      resend: email => postJson('/auth/resend-verification', { email }),
      getSearch: () => window.location.search,
      replaceSearch: () => {
        const url = new URL(window.location.href)
        url.search = ''
        window.history.replaceState(window.history.state, '', url.pathname + url.hash)
      },
    }),
  }, AccountGate))
}

async function getJson(path: string): Promise<MeResult> {
  const response = await fetch(path, { credentials: 'include' })
  return await response.json() as MeResult
}

async function postJson(path: string, body: Record<string, string>): Promise<AuthResult> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return await response.json() as AuthResult
}
