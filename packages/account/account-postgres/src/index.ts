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
  type AccountId,
  type AccountLookup,
  type BanResult,
  type DeleteResult,
  type OperatorAuditRecord,
  type OperatorAuditWrite,
  type RegisterResult,
  type ResetPasswordResult,
  type SignInLookup,
  type SignInResult,
  type SignInSessionId,
  type VerifyEmailResult,
} from '@deepseek-ai/dsh-account'
import type { Mailer } from '@deepseek-ai/dsh-mailer'
import { ensureSchema, SCHEMA_VERSION } from './schema.ts'
import { isUniqueViolation, openSql, type SqlClient } from './sql.ts'

export { SCHEMA_VERSION }
export { isUniqueViolation, openSql } from './sql.ts'
export type { SqlClient } from './sql.ts'

/** Default verification-token lifetime (24 hours). */
export const DEFAULT_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000
/** Default Sign-in session lifetime (14 sliding days). */
export const DEFAULT_SIGN_IN_TTL_MS = 14 * 24 * 60 * 60 * 1000
/** Default password-reset token lifetime (1 hour). */
export const DEFAULT_PASSWORD_RESET_TTL_MS = 60 * 60 * 1000
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
  /** Origin used to build verification and password-reset URLs (no trailing slash). */
  publicBaseUrl: string
  /** Verification-token lifetime in milliseconds. */
  verificationTtlMs?: number
  /** Sign-in session lifetime in milliseconds. */
  signInTtlMs?: number
  /** Password-reset token lifetime in milliseconds. */
  passwordResetTtlMs?: number
  /** Minimum accepted Password length. */
  passwordMinLength?: number
  /**
   * Account emails that are Operators. Compared after `normalizeEmail`.
   * Empty means no Operators; the first registrant is not special.
   */
  operatorEmails?: string[]
}

interface AccountRow {
  id: string
  email: string
  password_hash: string
  verified_at: number | bigint | null
  banned_at: number | bigint | null
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
    passwordResetTtlMs: z.number().min(1).default(DEFAULT_PASSWORD_RESET_TTL_MS),
    passwordMinLength: z.number().min(1).default(DEFAULT_PASSWORD_MIN_LENGTH),
    operatorEmails: z.array(z.string()).default([]),
  })

  private sql: SqlClient | undefined
  private dummyHash: string | undefined
  private readonly url: string
  private readonly publicBaseUrl: string
  private readonly verificationTtlMs: number
  private readonly signInTtlMs: number
  private readonly passwordResetTtlMs: number
  private readonly passwordMinLength: number
  private readonly operatorEmails: ReadonlySet<string>

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
    this.passwordResetTtlMs = config.passwordResetTtlMs ?? DEFAULT_PASSWORD_RESET_TTL_MS
    this.passwordMinLength = config.passwordMinLength ?? DEFAULT_PASSWORD_MIN_LENGTH
    const operators = new Set<string>()
    for (const email of config.operatorEmails ?? []) {
      const normalized = normalizeEmail(email)
      if (normalized === undefined) {
        throw new Error('account-postgres: operatorEmails contains an invalid email')
      }
      operators.add(normalized)
    }
    this.operatorEmails = operators
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
   *   the mailer rejected the send; `registration_frozen` when public
   *   registration is disabled.
   */
  override async register(email: string, password: string): Promise<RegisterResult> {
    const normalized = normalizeEmail(email)
    if (normalized === undefined) return { ok: false, error: 'invalid_email' }
    if (this.invalidPassword(password)) return { ok: false, error: 'invalid_password' }
    if (await this.isRegistrationFrozen()) return { ok: false, error: 'registration_frozen' }
    const id = randomUUID()
    const passwordHash = await hashPassword(password)
    const token = mintSecret()
    const now = Date.now()
    try {
      const frozen = await this.client().transaction(async (sql) => {
        await sql.query(
          'INSERT INTO registration_control (id, frozen_at) VALUES (1, NULL) ON CONFLICT (id) DO NOTHING',
        )
        const control = await sql.query(
          'SELECT frozen_at FROM registration_control WHERE id = 1 FOR UPDATE',
        )
        if (control.rows[0]?.['frozen_at'] != null) return true
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
        return false
      })
      if (frozen) return { ok: false, error: 'registration_frozen' }
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
   * After scrypt, re-reads `verified_at` / `banned_at` under `FOR UPDATE`.
   * @param email - visitor-supplied email.
   * @param password - visitor-supplied Password.
   * @returns a Sign-in session id on success, or `banned` when Ban is in force.
   */
  override async signIn(email: string, password: string): Promise<SignInResult> {
    const normalized = normalizeEmail(email)
    const found = normalized === undefined
      ? undefined
      : (await this.client().query(
        'SELECT id, email, password_hash, verified_at, banned_at FROM accounts WHERE email_normalized = $1',
        [normalized],
      )).rows[0] as AccountRow | undefined
    const hash = found?.password_hash ?? await this.dummyPasswordHash()
    const matches = await verifyPassword(password, hash)
    if (found === undefined || !matches) return { ok: false, error: 'invalid_credentials' }
    const session = mintSecret()
    const now = Date.now()
    const expiresAt = now + this.signInTtlMs
    return this.client().transaction(async (sql) => {
      const locked = await sql.query(
        'SELECT verified_at, banned_at FROM accounts WHERE id = $1 FOR UPDATE',
        [found.id],
      )
      const row = locked.rows[0] as Pick<AccountRow, 'verified_at' | 'banned_at'> | undefined
      /* v8 ignore next -- concurrent Deletion can drop the row between the hash read and this lock. */
      if (row === undefined) return { ok: false, error: 'invalid_credentials' }
      if (row.verified_at == null) return { ok: false, error: 'unverified' }
      if (row.banned_at != null) return { ok: false, error: 'banned' }
      await sql.query(
        `INSERT INTO sign_in_sessions (id_hash, account_id, created_at, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [session.hash, found.id, now, expiresAt],
      )
      return { ok: true, signInId: signInSessionId(session.raw), expiresAt }
    })
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
   * Resolve a presented Sign-in session id and slide its expiry forward.
   * @param signInId - the id the browser presented.
   * @returns the live Sign-in session, or `undefined` when it is unknown,
   *   expired, or the Account is Banned.
   */
  override async lookupSignIn(signInId: SignInSessionId): Promise<SignInLookup | undefined> {
    const now = Date.now()
    const expiresAt = now + this.signInTtlMs
    const found = await this.client().query(
      `UPDATE sign_in_sessions s
       SET expires_at = $1
       FROM accounts a
       WHERE s.id_hash = $2
         AND s.expires_at > $3
         AND s.account_id = a.id
         AND a.verified_at IS NOT NULL
         AND a.banned_at IS NULL
       RETURNING s.account_id, a.email, s.expires_at`,
      [expiresAt, hashSecret(signInId), now],
    )
    const row = found.rows[0] as SignInRow | undefined
    if (row === undefined) return undefined
    return {
      accountId: accountId(row.account_id),
      email: row.email,
      expiresAt: Number(row.expires_at),
      operator: this.operatorEmails.has(row.email),
    }
  }

  /**
   * Send a password-reset message for a verified Account.
   * @param email - visitor-supplied email.
   */
  override async requestPasswordReset(email: string): Promise<void> {
    const normalized = normalizeEmail(email)
    if (normalized === undefined) return
    const token = mintSecret()
    const now = Date.now()
    const updated = await this.client().transaction(async (sql) => {
      const found = await sql.query(
        'SELECT id, verified_at FROM accounts WHERE email_normalized = $1 FOR UPDATE',
        [normalized],
      )
      const account = found.rows[0] as Pick<AccountRow, 'id' | 'verified_at'> | undefined
      if (account === undefined || account.verified_at == null) return false
      await sql.query(
        `INSERT INTO password_reset_tokens (token_hash, account_id, expires_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (account_id) DO UPDATE
         SET token_hash = EXCLUDED.token_hash, expires_at = EXCLUDED.expires_at`,
        [token.hash, account.id, now + this.passwordResetTtlMs],
      )
      return true
    })
    if (!updated) return
    try {
      await this.sendPasswordReset(normalized, token.raw)
    } catch {
      // Mailer I/O. HTTP request-reset stays 200 so the route cannot enumerate Accounts.
    }
  }

  /**
   * Consume a password-reset token, set a new Password, and end every Sign-in session.
   * @param token - raw token from the password-reset URL.
   * @param password - visitor-supplied new Password.
   * @returns whether the Password was changed.
   */
  override async resetPassword(token: string, password: string): Promise<ResetPasswordResult> {
    if (this.invalidPassword(password)) return { ok: false, error: 'invalid_password' }
    if (token.length === 0) return { ok: false, error: 'invalid_or_expired' }
    const tokenHash = hashSecret(token)
    const now = Date.now()
    return this.client().transaction(async (sql) => {
      const found = await sql.query(
        `DELETE FROM password_reset_tokens
         WHERE token_hash = $1 AND expires_at > $2
         RETURNING account_id`,
        [tokenHash, now],
      )
      const row = found.rows[0] as TokenRow | undefined
      if (row === undefined) return { ok: false, error: 'invalid_or_expired' }
      const passwordHash = await hashPassword(password)
      await sql.query(
        'UPDATE accounts SET password_hash = $1 WHERE id = $2',
        [passwordHash, row.account_id],
      )
      await sql.query(
        'DELETE FROM sign_in_sessions WHERE account_id = $1',
        [row.account_id],
      )
      return { ok: true }
    })
  }

  /**
   * Ban an Account by email and end every Sign-in session for it.
   * @param email - target Account email.
   * @returns `{ ok: true }` when the Account exists, or `not_found`.
   */
  override async ban(email: string): Promise<BanResult> {
    const normalized = normalizeEmail(email)
    if (normalized === undefined) return { ok: false, error: 'invalid_email' }
    return this.client().transaction(async (sql) => {
      const found = await sql.query(
        'SELECT id FROM accounts WHERE email_normalized = $1 FOR UPDATE',
        [normalized],
      )
      const row = found.rows[0] as { id: string } | undefined
      if (row === undefined) return { ok: false, error: 'not_found' }
      await sql.query(
        'UPDATE accounts SET banned_at = $1 WHERE id = $2 AND banned_at IS NULL',
        [Date.now(), row.id],
      )
      await sql.query(
        'DELETE FROM sign_in_sessions WHERE account_id = $1',
        [row.id],
      )
      return { ok: true }
    })
  }

  /**
   * Lift a Ban and delete leftover Sign-in sessions so a raced insert cannot
   * become a live cookie.
   * @param email - target Account email.
   * @returns `{ ok: true }` when the Account exists, or `not_found`.
   */
  override async liftBan(email: string): Promise<BanResult> {
    const normalized = normalizeEmail(email)
    if (normalized === undefined) return { ok: false, error: 'invalid_email' }
    return this.client().transaction(async (sql) => {
      const found = await sql.query(
        'SELECT id FROM accounts WHERE email_normalized = $1 FOR UPDATE',
        [normalized],
      )
      const row = found.rows[0] as { id: string } | undefined
      if (row === undefined) return { ok: false, error: 'not_found' }
      await sql.query(
        'UPDATE accounts SET banned_at = NULL WHERE id = $1',
        [row.id],
      )
      await sql.query(
        'DELETE FROM sign_in_sessions WHERE account_id = $1',
        [row.id],
      )
      return { ok: true }
    })
  }

  /**
   * Erase the Account row. Child token and Sign-in session rows CASCADE.
   * @param id - opaque Account id.
   * @returns `{ ok: true }` when the row was deleted, or `not_found`.
   */
  override async deleteAccount(id: AccountId): Promise<DeleteResult> {
    const found = await this.client().query(
      'DELETE FROM accounts WHERE id = $1 RETURNING id',
      [id],
    )
    if (found.rows[0] === undefined) return { ok: false, error: 'not_found' }
    return { ok: true }
  }

  /**
   * Freeze or unfreeze public registration.
   * @param frozen - whether new registration is refused.
   */
  override async setRegistrationFrozen(frozen: boolean): Promise<void> {
    await this.client().query(
      `INSERT INTO registration_control (id, frozen_at) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET frozen_at = EXCLUDED.frozen_at`,
      [frozen ? Date.now() : null],
    )
  }

  /**
   * Whether public registration is frozen.
   * @returns true when `register` must return `registration_frozen`.
   */
  override async isRegistrationFrozen(): Promise<boolean> {
    const found = await this.client().query(
      'SELECT frozen_at FROM registration_control WHERE id = 1',
    )
    return found.rows[0]?.['frozen_at'] != null
  }

  /**
   * Look up an Account by email, including Banned and Unverified rows.
   * @param email - target Account email.
   * @returns the summary, or `undefined` when no Account exists.
   */
  override async lookupByEmail(email: string): Promise<AccountLookup | undefined> {
    const normalized = normalizeEmail(email)
    if (normalized === undefined) return undefined
    const found = await this.client().query(
      'SELECT id, email, verified_at, banned_at FROM accounts WHERE email_normalized = $1',
      [normalized],
    )
    return this.toLookup(found.rows[0] as AccountRow | undefined)
  }

  /**
   * Look up an Account by id, including Banned and Unverified rows.
   * @param id - opaque Account id.
   * @returns the summary, or `undefined` when no Account exists.
   */
  override async lookupById(id: AccountId): Promise<AccountLookup | undefined> {
    const found = await this.client().query(
      'SELECT id, email, verified_at, banned_at FROM accounts WHERE id = $1',
      [id],
    )
    return this.toLookup(found.rows[0] as AccountRow | undefined)
  }

  /**
   * Append one Operator-access opening.
   * @param entry - Operator, target, optional Session, and time.
   * @returns the persisted row including its id.
   */
  override async recordOperatorAccess(entry: OperatorAuditWrite): Promise<OperatorAuditRecord> {
    const id = randomUUID()
    await this.client().query(
      `INSERT INTO operator_audit_log
        (id, operator_account_id, operator_email, target_account_id, session_id, opened_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        id,
        entry.operatorAccountId,
        entry.operatorEmail,
        entry.targetAccountId,
        entry.sessionId ?? null,
        entry.openedAt,
      ],
    )
    return { id, ...entry }
  }

  /**
   * List Operator-access openings, newest first.
   * @returns every audit row.
   */
  override async listOperatorAccess(): Promise<OperatorAuditRecord[]> {
    const found = await this.client().query(
      `SELECT id, operator_account_id, operator_email, target_account_id, session_id, opened_at
       FROM operator_audit_log
       ORDER BY opened_at DESC, id DESC`,
    )
    return found.rows.map((row) => {
      const sessionId = row['session_id']
      return {
        id: String(row['id']),
        operatorAccountId: accountId(String(row['operator_account_id'])),
        operatorEmail: String(row['operator_email']),
        targetAccountId: accountId(String(row['target_account_id'])),
        ...typeof sessionId === 'string' && sessionId !== '' ? { sessionId } : {},
        openedAt: Number(row['opened_at']),
      }
    })
  }

  private toLookup(row: AccountRow | undefined): AccountLookup | undefined {
    if (row === undefined) return undefined
    return {
      accountId: accountId(row.id),
      email: row.email,
      verified: row.verified_at != null,
      banned: row.banned_at != null,
    }
  }

  private invalidPassword(password: string): boolean {
    return password.length < this.passwordMinLength || password.length > PASSWORD_MAX_LENGTH
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

  private async sendPasswordReset(to: string, rawToken: string): Promise<void> {
    const resetUrl = `${this.publicBaseUrl}/reset?token=${rawToken}`
    await this.mailer.send({
      to,
      subject: 'Reset your password',
      text: `Reset the Password for this Account by opening:\n${resetUrl}\n`,
    })
  }
}

export default PostgresAccounts
