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
