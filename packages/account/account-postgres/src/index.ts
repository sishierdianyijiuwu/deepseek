/**
 * PostgreSQL Service Provider for the Account capability seam.
 * @module @deepseek-ai/dsh-account-postgres
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  Accounts,
  accountId,
  hashPassword,
  hashSecret,
  mintSecret,
  normalizeEmail,
  signInSessionId,
  verifyPassword,
  type RegisterResult,
  type SignInLookup,
  type SignInResult,
  type SignInSessionId,
  type VerifyEmailResult,
} from '@deepseek-ai/dsh-account'
import type { Mailer } from '@deepseek-ai/dsh-mailer'
import { ensureSchema, SCHEMA_VERSION } from './schema.ts'
import { isUniqueViolation, openSql, type SqlClient } from './sql.ts'

export { SCHEMA_VERSION }

/** Default verification-token lifetime (24 hours). */
export const DEFAULT_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000
/** Default Sign-in session lifetime (14 days; sliding is ticket #3). */
export const DEFAULT_SIGN_IN_TTL_MS = 14 * 24 * 60 * 60 * 1000
/** Default minimum Password length. */
export const DEFAULT_PASSWORD_MIN_LENGTH = 8
/** Upper bound that keeps scrypt from becoming a request-body bomb. */
export const PASSWORD_MAX_LENGTH = 1024

/** Plugin config. */
export interface Config {
  /**
   * PostgreSQL URL (`postgres://…` / `postgresql://…`), or `pglite:` for an
   * in-process PostgreSQL engine used by tests.
   */
  url: string
  /** Origin used to build verification URLs (no trailing slash). */
  publicBaseUrl: string
  /** Verification-token lifetime in milliseconds. */
  verificationTtlMs?: number
  /** Sign-in session lifetime in milliseconds. */
  signInTtlMs?: number
  /** Minimum accepted Password length. */
  passwordMinLength?: number
}

interface AccountRow {
  id: string
  email: string
  password_hash: string
  verified_at: number | bigint | null
}

interface TokenRow {
  account_id: string
}

interface SignInRow {
  account_id: string
  email: string
  expires_at: number | bigint
}

/** PostgreSQL-backed Accounts (`ctx.accounts`). */
export class PostgresAccounts extends Accounts {
  static inject = ['mailer']

  static Config: z<Config> = z.object({
    url: z.string().required(),
    publicBaseUrl: z.string().required(),
    verificationTtlMs: z.number().min(1).default(DEFAULT_VERIFICATION_TTL_MS),
    signInTtlMs: z.number().min(1).default(DEFAULT_SIGN_IN_TTL_MS),
    passwordMinLength: z.number().min(1).default(DEFAULT_PASSWORD_MIN_LENGTH),
  })

  private sql: SqlClient | undefined
  private dummyHash: string | undefined
  private readonly url: string
  private readonly publicBaseUrl: string
  private readonly verificationTtlMs: number
  private readonly signInTtlMs: number
  private readonly passwordMinLength: number

  /**
   * @param ctx - Cordis context.
   * @param config - validated provider config.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx)
    const url = config.url
    const publicBaseUrl = config.publicBaseUrl
    if (url === '' || publicBaseUrl === '') {
      throw new Error('account-postgres: url and publicBaseUrl are required')
    }
    this.url = url
    this.publicBaseUrl = publicBaseUrl.replace(/\/+$/, '')
    this.verificationTtlMs = config.verificationTtlMs ?? DEFAULT_VERIFICATION_TTL_MS
    this.signInTtlMs = config.signInTtlMs ?? DEFAULT_SIGN_IN_TTL_MS
    this.passwordMinLength = config.passwordMinLength ?? DEFAULT_PASSWORD_MIN_LENGTH
  }

  private get mailer(): Mailer {
    return this.ctx.mailer
  }

  private client(): SqlClient {
    if (this.sql === undefined) throw new Error('account-postgres: not started')
    return this.sql
  }

  /** Open the database and apply the schema; a failure rejects the fiber. */
  async [Service.init](): Promise<void> {
    const sql = await openSql(this.url)
    try {
      await ensureSchema(sql)
    } catch (error) {
      await sql.close()
      throw error
    }
    this.sql = sql
    this.ctx.effect(() => () => {
      this.sql = undefined
      void sql.close()
    }, 'account-postgres: close sql')
  }

  /**
   * Create an Unverified Account and send a verification message.
   * @param email - visitor-supplied email.
   * @param password - visitor-supplied Password.
   * @returns `{ ok: true }` when the Unverified Account exists and the
   *   verification message was sent; `mail_failed` when the row exists but
   *   the mailer rejected the send.
   */
  override async register(email: string, password: string): Promise<RegisterResult> {
    const normalized = normalizeEmail(email)
    if (normalized === undefined) return { ok: false, error: 'invalid_email' }
    if (password.length < this.passwordMinLength || password.length > PASSWORD_MAX_LENGTH) {
      return { ok: false, error: 'invalid_password' }
    }
    const id = randomUUID()
    const passwordHash = await hashPassword(password)
    const token = mintSecret()
    const now = Date.now()
    try {
      await this.client().transaction(async (sql) => {
        await sql.query(
          `INSERT INTO accounts (id, email, email_normalized, password_hash, verified_at, created_at)
           VALUES ($1, $2, $3, $4, NULL, $5)`,
          [id, normalized, normalized, passwordHash, now],
        )
        await sql.query(
          `INSERT INTO email_verification_tokens (token_hash, account_id, expires_at)
           VALUES ($1, $2, $3)`,
          [token.hash, id, now + this.verificationTtlMs],
        )
      })
    } catch (error) {
      if (isUniqueViolation(error)) return { ok: false, error: 'email_taken' }
      throw error
    }
    try {
      await this.sendVerification(normalized, token.raw)
    } catch {
      // Mailer I/O. The Unverified Account row is already committed.
      return { ok: false, error: 'mail_failed' }
    }
    return { ok: true }
  }

  /**
   * Consume a single-use verification token.
   * @param token - raw token from the verification URL.
   * @returns whether the Account is now verified.
   */
  override async verifyEmail(token: string): Promise<VerifyEmailResult> {
    if (token.length === 0) return { ok: false, error: 'invalid_or_expired' }
    const tokenHash = hashSecret(token)
    const now = Date.now()
    return this.client().transaction(async (sql) => {
      const found = await sql.query(
        'SELECT account_id FROM email_verification_tokens WHERE token_hash = $1 AND expires_at > $2',
        [tokenHash, now],
      )
      const row = found.rows[0] as TokenRow | undefined
      if (row === undefined) return { ok: false, error: 'invalid_or_expired' }
      await sql.query(
        'UPDATE accounts SET verified_at = $1 WHERE id = $2 AND verified_at IS NULL',
        [now, row.account_id],
      )
      await sql.query(
        'DELETE FROM email_verification_tokens WHERE account_id = $1',
        [row.account_id],
      )
      return { ok: true }
    })
  }

  /**
   * Send a fresh verification message for an Unverified Account.
   * @param email - visitor-supplied email.
   */
  override async resendVerification(email: string): Promise<void> {
    const normalized = normalizeEmail(email)
    if (normalized === undefined) return
    const token = mintSecret()
    const now = Date.now()
    const updated = await this.client().transaction(async (sql) => {
      const found = await sql.query(
        'SELECT id, email, password_hash, verified_at FROM accounts WHERE email_normalized = $1',
        [normalized],
      )
      const account = found.rows[0] as AccountRow | undefined
      if (account === undefined || account.verified_at != null) return false
      await sql.query(
        'DELETE FROM email_verification_tokens WHERE account_id = $1',
        [account.id],
      )
      await sql.query(
        `INSERT INTO email_verification_tokens (token_hash, account_id, expires_at)
         VALUES ($1, $2, $3)`,
        [token.hash, account.id, now + this.verificationTtlMs],
      )
      return true
    })
    if (!updated) return
    try {
      await this.sendVerification(normalized, token.raw)
    } catch {
      // Mailer I/O. HTTP resend stays 200 so the route cannot enumerate Unverified Accounts.
    }
  }

  /**
   * Create a Sign-in session after a verified Account presents the Password.
   * @param email - visitor-supplied email.
   * @param password - visitor-supplied Password.
   * @returns a Sign-in session id on success.
   */
  override async signIn(email: string, password: string): Promise<SignInResult> {
    const normalized = normalizeEmail(email)
    const found = normalized === undefined
      ? undefined
      : (await this.client().query(
        'SELECT id, email, password_hash, verified_at FROM accounts WHERE email_normalized = $1',
        [normalized],
      )).rows[0] as AccountRow | undefined
    const hash = found?.password_hash ?? await this.dummyPasswordHash()
    const matches = await verifyPassword(password, hash)
    if (found === undefined || !matches) return { ok: false, error: 'invalid_credentials' }
    if (found.verified_at == null) return { ok: false, error: 'unverified' }
    const session = mintSecret()
    const now = Date.now()
    const expiresAt = now + this.signInTtlMs
    await this.client().query(
      `INSERT INTO sign_in_sessions (id_hash, account_id, created_at, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [session.hash, found.id, now, expiresAt],
    )
    return { ok: true, signInId: signInSessionId(session.raw), expiresAt }
  }

  /**
   * End one Sign-in session.
   * @param signInId - the id the browser presented.
   */
  override async signOut(signInId: SignInSessionId): Promise<void> {
    await this.client().query(
      'DELETE FROM sign_in_sessions WHERE id_hash = $1',
      [hashSecret(signInId)],
    )
  }

  /**
   * Resolve a presented Sign-in session id.
   * @param signInId - the id the browser presented.
   * @returns the live Sign-in session, or `undefined` when it is unknown or expired.
   */
  override async lookupSignIn(signInId: SignInSessionId): Promise<SignInLookup | undefined> {
    const now = Date.now()
    const found = await this.client().query(
      `SELECT s.account_id, a.email, s.expires_at
       FROM sign_in_sessions s
       JOIN accounts a ON a.id = s.account_id
       WHERE s.id_hash = $1 AND s.expires_at > $2 AND a.verified_at IS NOT NULL`,
      [hashSecret(signInId), now],
    )
    const row = found.rows[0] as SignInRow | undefined
    if (row === undefined) return undefined
    return {
      accountId: accountId(row.account_id),
      email: row.email,
      expiresAt: Number(row.expires_at),
    }
  }

  private async dummyPasswordHash(): Promise<string> {
    this.dummyHash ??= await hashPassword('account-postgres-timing-dummy')
    return this.dummyHash
  }

  private async sendVerification(to: string, rawToken: string): Promise<void> {
    const verifyUrl = `${this.publicBaseUrl}/verify?token=${rawToken}`
    await this.mailer.send({
      to,
      subject: 'Verify your email',
      text: `Verify this email address by opening:\n${verifyUrl}\n`,
    })
  }
}

export default PostgresAccounts
