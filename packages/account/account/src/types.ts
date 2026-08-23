/**
 * Vocabulary types for the Account capability seam.
 * @module @deepseek-ai/dsh-account/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque Account id. */
export type AccountId = Branded<'AccountId'>

/** Opaque Sign-in session id presented by the browser (HTTP-only cookie value). */
export type SignInSessionId = Branded<'SignInSessionId'>

/** Outcome of {@link import('./index.ts').Accounts.register}. */
export type RegisterResult =
  | { ok: true }
  | { ok: false; error: 'invalid_email' | 'invalid_password' | 'email_taken' | 'mail_failed' | 'registration_frozen' }

/** Outcome of {@link import('./index.ts').Accounts.verifyEmail}. */
export type VerifyEmailResult =
  | { ok: true }
  | { ok: false; error: 'invalid_or_expired' }

/** Outcome of {@link import('./index.ts').Accounts.signIn}. */
export type SignInResult =
  | { ok: true; signInId: SignInSessionId; expiresAt: number }
  | { ok: false; error: 'invalid_credentials' | 'unverified' | 'banned' }

/** Outcome of {@link import('./index.ts').Accounts.ban} and {@link import('./index.ts').Accounts.liftBan}. */
export type BanResult =
  | { ok: true }
  | { ok: false; error: 'invalid_email' | 'not_found' }

/** Outcome of {@link import('./index.ts').Accounts.resetPassword}. */
export type ResetPasswordResult =
  | { ok: true }
  | { ok: false; error: 'invalid_or_expired' | 'invalid_password' }

/** A live Sign-in session looked up from the id the browser presented. */
export interface SignInLookup {
  /** Owning Account. */
  accountId: AccountId
  /** Normalized email of the Account. */
  email: string
  /** Epoch-ms expiry of this Sign-in session after the latest slide. */
  expiresAt: number
  /** True when `email` is on the host operator list. */
  operator: boolean
}

/** Existence, verified, and Ban flags for Operator lookup. No Session bodies. */
export interface AccountLookup {
  /** Opaque Account id. */
  accountId: AccountId
  /** Normalized email. */
  email: string
  /** True when email verification has completed. */
  verified: boolean
  /** True when Ban is in effect. */
  banned: boolean
}

/**
 * One Operator-access opening. `sessionId` is absent when the opening is the
 * Account (list/mux/Workspace files) rather than one Session log.
 */
export interface OperatorAuditRecord {
  /** Opaque row id. */
  id: string
  /** Operator who opened. */
  operatorAccountId: AccountId
  /** Operator email at the opening. */
  operatorEmail: string
  /** Account that was opened. */
  targetAccountId: AccountId
  /** Session id when this opening is a Session log. */
  sessionId?: string
  /** Epoch-ms instant of the opening. */
  openedAt: number
}

/** Fields {@link import('./index.ts').Accounts.recordOperatorAccess} persists. */
export type OperatorAuditWrite = Omit<OperatorAuditRecord, 'id'>

/** Active Operator access bound for one `/api` request or WebSocket. */
export interface OperatorAccess {
  /** Signed-in Operator Account. */
  operatorAccountId: AccountId
  /** Operator email used on the audit row. */
  operatorEmail: string
  /** Account whose Sessions and Workspace files are visible read-only. */
  targetAccountId: AccountId
}

/** A verification message the mailer delivers. */
export interface VerificationMail {
  /** Recipient email. */
  to: string
  /** Absolute verification URL including the secret token. */
  verifyUrl: string
}

/** A password-reset message the mailer delivers. */
export interface PasswordResetMail {
  /** Recipient email. */
  to: string
  /** Absolute password-reset URL including the secret token. */
  resetUrl: string
}
