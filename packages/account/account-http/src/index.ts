/**
 * HTTP Consumer for the Account capability: unauthenticated auth routes beside `/api`.
 * @module @deepseek-ai/dsh-account-http
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SIGN_IN_COOKIE, cookieValue, signInSessionId } from '@deepseek-ai/dsh-account'
import type { AccountId, Accounts, SignInLookup } from '@deepseek-ai/dsh-account'

export { SIGN_IN_COOKIE, cookieValue }
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace-cloud'

/** Maximum JSON body accepted on auth POST routes. */
export const MAX_AUTH_BODY_BYTES = 64 * 1024

/** Plugin config. */
export interface Config {
  /** Set the cookie Secure flag (HTTPS reverse-proxy deployments). */
  cookieSecure?: boolean
}

export const Config: z<Config> = z.object({
  cookieSecure: z.boolean().default(false),
})

/** Stable Cordis plugin name. */
export const name = 'account-http'

/** Services required before routes can be claimed. */
export const inject = ['webServer', 'accounts']

/**
 * Register auth HTTP routes on `ctx.webServer`.
 * @param ctx - Cordis context with `webServer` and `accounts`.
 * @param config - cookie flags.
 */
export function apply(ctx: Context, config: Config): void {
  const secure = config.cookieSecure === true
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/auth',
    handler: (req, res) => handleAuth(req, res, ctx, secure),
  }), 'account-http: /auth')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/verify',
    handler: (req, res) => handleVerify(req, res, ctx.accounts),
  }), 'account-http: /verify')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/reset',
    handler: (req, res) => { handleResetLink(req, res) },
  }), 'account-http: /reset')
}

/**
 * Dispatch `/auth/*` by pathname and method.
 * @param req - incoming request.
 * @param res - response to write.
 * @param ctx - Cordis context with `accounts` and optional owned-data services.
 * @param cookieSecure - cookie Secure flag.
 */
export async function handleAuth(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Context,
  cookieSecure: boolean,
): Promise<void> {
  const accounts = ctx.accounts
  /* v8 ignore next -- node:http always sets url/method on server requests */
  const url = new URL(req.url ?? '/', 'http://dsh.internal')
  /* v8 ignore next -- node:http always sets method on server requests */
  const method = req.method ?? 'GET'
  if (url.pathname === '/auth/me') {
    if (method !== 'GET') {
      res.writeHead(405, { allow: 'GET' })
      res.end()
      return
    }
    await sendMe(req, res, accounts, cookieSecure)
    return
  }
  if (url.pathname === '/auth/operator/registration') {
    if (method !== 'GET') {
      res.writeHead(405, { allow: 'GET' })
      res.end()
      return
    }
    const operator = await requireOperator(req, res, accounts, cookieSecure)
    if (operator === undefined) return
    writeJson(res, 200, { ok: true, frozen: await accounts.isRegistrationFrozen() })
    return
  }
  if (url.pathname === '/auth/operator/account') {
    if (method !== 'GET') {
      res.writeHead(405, { allow: 'GET' })
      res.end()
      return
    }
    const operator = await requireOperator(req, res, accounts, cookieSecure)
    if (operator === undefined) return
    const email = url.searchParams.get('email') ?? ''
    const found = await accounts.lookupByEmail(email)
    if (found === undefined) {
      writeJson(res, 200, failure('not_found', 'No Account for this email'))
      return
    }
    writeJson(res, 200, {
      ok: true,
      accountId: found.accountId,
      email: found.email,
      verified: found.verified,
      banned: found.banned,
    })
    return
  }
  if (url.pathname === '/auth/operator/audit') {
    if (method !== 'GET') {
      res.writeHead(405, { allow: 'GET' })
      res.end()
      return
    }
    const operator = await requireOperator(req, res, accounts, cookieSecure)
    if (operator === undefined) return
    writeJson(res, 200, { ok: true, items: await accounts.listOperatorAccess() })
    return
  }
  if (method !== 'POST') {
    res.writeHead(405, { allow: 'POST' })
    res.end()
    return
  }
  if (url.pathname === '/auth/register') {
    const body = await readJsonObject(req, res)
    if (body === undefined) return
    const email = stringField(body, 'email')
    const password = stringField(body, 'password')
    if (email === undefined || password === undefined) {
      writeJson(res, 200, failure('invalid_request', 'email and password are required'))
      return
    }
    const result = await accounts.register(email, password)
    if (!result.ok) {
      writeJson(res, 200, failure(result.error, registerMessage(result.error)))
      return
    }
    writeJson(res, 200, { ok: true })
    return
  }
  if (url.pathname === '/auth/sign-in') {
    const body = await readJsonObject(req, res)
    if (body === undefined) return
    const email = stringField(body, 'email')
    const password = stringField(body, 'password')
    if (email === undefined || password === undefined) {
      writeJson(res, 200, failure('invalid_request', 'email and password are required'))
      return
    }
    const result = await accounts.signIn(email, password)
    if (!result.ok) {
      writeJson(res, 200, failure(result.error, signInMessage(result.error)))
      return
    }
    const maxAge = Math.max(0, Math.floor((result.expiresAt - Date.now()) / 1000))
    res.setHeader('set-cookie', serializeCookie(SIGN_IN_COOKIE, result.signInId, maxAge, cookieSecure))
    writeJson(res, 200, { ok: true })
    return
  }
  if (url.pathname === '/auth/sign-out') {
    const id = cookieValue(req.headers.cookie, SIGN_IN_COOKIE)
    if (id !== undefined) await accounts.signOut(signInSessionId(id))
    res.setHeader('set-cookie', serializeCookie(SIGN_IN_COOKIE, '', 0, cookieSecure))
    writeJson(res, 200, { ok: true })
    return
  }
  if (url.pathname === '/auth/delete') {
    const id = cookieValue(req.headers.cookie, SIGN_IN_COOKIE)
    if (id === undefined) {
      writeJson(res, 200, failure('forbidden', 'Not allowed'))
      return
    }
    const session = await accounts.lookupSignIn(signInSessionId(id))
    if (session === undefined) {
      writeJson(res, 200, failure('forbidden', 'Not allowed'))
      return
    }
    await accounts.deleteAccount(session.accountId)
    await eraseOwnedData(ctx, session.accountId)
    res.setHeader('set-cookie', serializeCookie(SIGN_IN_COOKIE, '', 0, cookieSecure))
    writeJson(res, 200, { ok: true })
    return
  }
  if (url.pathname === '/auth/resend-verification') {
    const body = await readJsonObject(req, res)
    if (body === undefined) return
    const email = stringField(body, 'email')
    if (email === undefined) {
      writeJson(res, 200, failure('invalid_request', 'email is required'))
      return
    }
    await accounts.resendVerification(email)
    writeJson(res, 200, { ok: true })
    return
  }
  if (url.pathname === '/auth/request-password-reset') {
    const body = await readJsonObject(req, res)
    if (body === undefined) return
    const email = stringField(body, 'email')
    if (email === undefined) {
      writeJson(res, 200, failure('invalid_request', 'email is required'))
      return
    }
    await accounts.requestPasswordReset(email)
    writeJson(res, 200, { ok: true })
    return
  }
  if (url.pathname === '/auth/reset-password') {
    const body = await readJsonObject(req, res)
    if (body === undefined) return
    const token = stringField(body, 'token')
    const password = stringField(body, 'password')
    if (token === undefined || password === undefined) {
      writeJson(res, 200, failure('invalid_request', 'token and password are required'))
      return
    }
    const result = await accounts.resetPassword(token, password)
    if (!result.ok) {
      writeJson(res, 200, failure(result.error, resetMessage(result.error)))
      return
    }
    res.setHeader('set-cookie', serializeCookie(SIGN_IN_COOKIE, '', 0, cookieSecure))
    writeJson(res, 200, { ok: true })
    return
  }
  if (url.pathname === '/auth/operator/ban') {
    await handleOperatorBan(req, res, accounts, cookieSecure, 'ban')
    return
  }
  if (url.pathname === '/auth/operator/lift-ban') {
    await handleOperatorBan(req, res, accounts, cookieSecure, 'liftBan')
    return
  }
  if (url.pathname === '/auth/operator/freeze-registration') {
    const operator = await requireOperator(req, res, accounts, cookieSecure)
    if (operator === undefined) return
    const body = await readJsonObject(req, res)
    if (body === undefined) return
    const frozen = booleanField(body, 'frozen')
    if (frozen === undefined) {
      writeJson(res, 200, failure('invalid_request', 'frozen is required'))
      return
    }
    await accounts.setRegistrationFrozen(frozen)
    writeJson(res, 200, { ok: true, frozen })
    return
  }
  res.writeHead(404)
  res.end()
}

/**
 * Complete email verification from a named GET `/verify?token=` route, then
 * redirect onto `/` so the SPA can show the outcome. HEAD returns 200 and
 * does not consume the token.
 * @param req - incoming request.
 * @param res - response to write.
 * @param accounts - Account service.
 */
export async function handleVerify(
  req: IncomingMessage,
  res: ServerResponse,
  accounts: Accounts,
): Promise<void> {
  /* v8 ignore next -- node:http always sets method on server requests */
  const method = req.method ?? 'GET'
  if (method === 'HEAD') {
    // Mail scanners HEAD mailbox links; do not consume the single-use token.
    res.writeHead(200)
    res.end()
    return
  }
  if (method !== 'GET') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return
  }
  /* v8 ignore next -- node:http always sets url on server requests */
  const token = new URL(req.url ?? '/', 'http://dsh.internal').searchParams.get('token') ?? ''
  const result = await accounts.verifyEmail(token)
  res.writeHead(302, { location: result.ok ? '/?verified=ok' : '/?verified=invalid' })
  res.end()
}

/**
 * Land a mailbox password-reset link on the SPA without consuming the token.
 * HEAD returns 200 so mail scanners do not burn the single-use secret.
 * @param req - incoming request.
 * @param res - response to write.
 */
export function handleResetLink(
  req: IncomingMessage,
  res: ServerResponse,
): void {
  /* v8 ignore next -- node:http always sets method on server requests */
  const method = req.method ?? 'GET'
  if (method === 'HEAD') {
    res.writeHead(200)
    res.end()
    return
  }
  if (method !== 'GET') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return
  }
  /* v8 ignore next -- node:http always sets url on server requests */
  const token = new URL(req.url ?? '/', 'http://dsh.internal').searchParams.get('token') ?? ''
  res.writeHead(302, { location: `/?reset=${encodeURIComponent(token)}` })
  res.end()
}

async function sendMe(
  req: IncomingMessage,
  res: ServerResponse,
  accounts: Accounts,
  cookieSecure: boolean,
): Promise<void> {
  const id = cookieValue(req.headers.cookie, SIGN_IN_COOKIE)
  if (id === undefined) {
    writeJson(res, 200, { ok: true, signedIn: false })
    return
  }
  const session = await accounts.lookupSignIn(signInSessionId(id))
  if (session === undefined) {
    writeJson(res, 200, { ok: true, signedIn: false })
    return
  }
  const maxAge = Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000))
  res.setHeader('set-cookie', serializeCookie(SIGN_IN_COOKIE, id, maxAge, cookieSecure))
  writeJson(res, 200, {
    ok: true,
    signedIn: true,
    email: session.email,
    operator: session.operator,
  })
}

async function requireOperator(
  req: IncomingMessage,
  res: ServerResponse,
  accounts: Accounts,
  cookieSecure: boolean,
): Promise<SignInLookup | undefined> {
  const id = cookieValue(req.headers.cookie, SIGN_IN_COOKIE)
  if (id === undefined) {
    writeJson(res, 200, failure('forbidden', 'Not allowed'))
    return undefined
  }
  const session = await accounts.lookupSignIn(signInSessionId(id))
  if (session === undefined || !session.operator) {
    writeJson(res, 200, failure('forbidden', 'Not allowed'))
    return undefined
  }
  const maxAge = Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000))
  res.setHeader('set-cookie', serializeCookie(SIGN_IN_COOKIE, id, maxAge, cookieSecure))
  return session
}

/**
 * Erase Workspaces, Credentials, and Session logs the deleted Account owned.
 * Missing optional services are skipped so auth-only compositions still delete
 * the Account row.
 * @param ctx - Cordis context that may carry those services.
 * @param accountId - Account whose owned data is erased.
 */
async function eraseOwnedData(ctx: Context, accountId: AccountId): Promise<void> {
  const cloud = ctx.get('cloudWorkspaces')
  if (cloud !== undefined) await cloud.deleteAllOwned(accountId)
  await ctx.get('credentials')?.eraseOwned(accountId)
  await ctx.get('sessionPersistence')?.deleteOwned(accountId)
}

async function handleOperatorBan(
  req: IncomingMessage,
  res: ServerResponse,
  accounts: Accounts,
  cookieSecure: boolean,
  action: 'ban' | 'liftBan',
): Promise<void> {
  const operator = await requireOperator(req, res, accounts, cookieSecure)
  if (operator === undefined) return
  const body = await readJsonObject(req, res)
  if (body === undefined) return
  const email = stringField(body, 'email')
  if (email === undefined) {
    writeJson(res, 200, failure('invalid_request', 'email is required'))
    return
  }
  const result = action === 'ban' ? await accounts.ban(email) : await accounts.liftBan(email)
  if (!result.ok) {
    writeJson(res, 200, failure(result.error, banMessage(result.error)))
    return
  }
  writeJson(res, 200, { ok: true })
}

/**
 * Read a JSON object body or write a carrier error and return `undefined`.
 * @param req - incoming request.
 * @param res - response to write on failure.
 * @returns the parsed object, or `undefined` after writing the error.
 */
export async function readJsonObject(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Record<string, unknown> | undefined> {
  const type = req.headers['content-type']
  if (type !== undefined && !type.toLowerCase().startsWith('application/json')) {
    res.writeHead(415)
    res.end()
    return undefined
  }
  const declared = req.headers['content-length']
  if (declared !== undefined && Number(declared) > MAX_AUTH_BODY_BYTES) {
    res.writeHead(413)
    res.end()
    req.destroy()
    return undefined
  }
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    received += buffer.byteLength
    if (received > MAX_AUTH_BODY_BYTES) {
      res.writeHead(413)
      res.end()
      req.destroy()
      return undefined
    }
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim() === '') {
    writeJson(res, 400, failure('invalid_request', 'JSON body is required'))
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    res.writeHead(400)
    res.end()
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    writeJson(res, 400, failure('invalid_request', 'JSON object is required'))
    return undefined
  }
  return parsed as Record<string, unknown>
}

/**
 * Serialize one Set-Cookie value.
 * @param cookieName - cookie name.
 * @param value - cookie value (empty clears).
 * @param maxAge - Max-Age seconds.
 * @param secure - Secure flag.
 * @returns the header value.
 */
export function serializeCookie(
  cookieName: string,
  value: string,
  maxAge: number,
  secure: boolean,
): string {
  const parts = [
    `${cookieName}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${String(Math.max(0, maxAge))}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  return typeof value === 'string' ? value : undefined
}

function booleanField(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key]
  return typeof value === 'boolean' ? value : undefined
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(json)
}

function failure(code: string, message: string): { ok: false; error: { code: string; message: string } } {
  return { ok: false, error: { code, message } }
}

function registerMessage(
  code: 'invalid_email' | 'invalid_password' | 'email_taken' | 'mail_failed' | 'registration_frozen',
): string {
  if (code === 'invalid_email') return 'Enter a valid email address'
  if (code === 'invalid_password') return 'Password is too short'
  if (code === 'mail_failed') return 'Account created; send a new verification email'
  if (code === 'registration_frozen') return 'Registration is currently disabled'
  return 'An Account already exists for this email'
}

function signInMessage(code: 'invalid_credentials' | 'unverified' | 'banned'): string {
  if (code === 'unverified') return 'Verify the email address before signing in'
  if (code === 'banned') return 'This Account cannot sign in'
  return 'Email or password is incorrect'
}

function banMessage(code: 'invalid_email' | 'not_found'): string {
  if (code === 'invalid_email') return 'Enter a valid email address'
  return 'No Account for this email'
}

function resetMessage(code: 'invalid_or_expired' | 'invalid_password'): string {
  if (code === 'invalid_password') return 'Password is too short'
  return 'That reset link is invalid or expired'
}
