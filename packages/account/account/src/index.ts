/**
 * Service Definition for the Account capability seam (`ctx.accounts`).
 * Providers persist Account and Sign-in session rows; the HTTP Consumer
 * registers unauthenticated routes beside `/api`.
 * @module @deepseek-ai/dsh-account
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  AccountId,
  AccountLookup,
  BanResult,
  DeleteResult,
  OperatorAuditRecord,
  OperatorAuditWrite,
  RegisterResult,
  ResetPasswordResult,
  SignInLookup,
  SignInResult,
  SignInSessionId,
  VerifyEmailResult,
} from './types.ts'

export { hashPassword, verifyPassword } from './password.ts'
export { equalSecretHash, hashSecret, mintSecret } from './secret.ts'
export { normalizeEmail } from './email.ts'
export {
  SIGN_IN_COOKIE,
  OPERATOR_ACCESS_HEADER,
  cookieValue,
  currentAccountId,
  currentOperatorAccess,
  viewingAccountId,
  runWithAccount,
  runWithOperatorAccess,
} from './request.ts'
export type {
  AccountId,
  AccountLookup,
  BanResult,
  DeleteResult,
  OperatorAccess,
  OperatorAuditRecord,
  OperatorAuditWrite,
  PasswordResetMail,
  RegisterResult,
  ResetPasswordResult,
  SignInLookup,
  SignInResult,
  SignInSessionId,
  VerificationMail,
  VerifyEmailResult,
} from './types.ts'

/**
 * Brand a raw string as an {@link AccountId}.
 * @param value - opaque Account id.
 * @returns the branded id.
 */
export function accountId(value: string): AccountId {
  return value as AccountId
}

/**
 * Brand a raw string as a {@link SignInSessionId}.
 * @param value - opaque Sign-in session id.
 * @returns the branded id.
 */
export function signInSessionId(value: string): SignInSessionId {
  return value as SignInSessionId
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    accounts: Accounts
  }
}

/**
 * Abstract Account service. Subclass, implement the methods, and load the
 * subclass as a plugin — it registers as `ctx.accounts`.
 */
export abstract class Accounts extends Service {
  constructor(ctx: Context) {
    super(ctx, 'accounts')
  }

  /**
   * Create an Unverified Account and send a verification message.
   * @param email - visitor-supplied email.
   * @param password - visitor-supplied Password.
   * @returns `{ ok: true }` when the Unverified Account exists and the
   *   verification message was sent; `mail_failed` when the row exists but
   *   the mailer rejected the send; `registration_frozen` when an Operator
   *   has disabled public registration.
   */
  abstract register(email: string, password: string): Promise<RegisterResult>

  /**
   * Consume a single-use verification token from the mailbox link.
   * @param token - raw token from the verification URL.
   * @returns whether the Account is now verified.
   */
  abstract verifyEmail(token: string): Promise<VerifyEmailResult>

  /**
   * Send a fresh verification message when the email belongs to an Unverified
   * Account. Unknown or already-verified addresses are a silent success so the
   * call cannot enumerate Accounts.
   * @param email - visitor-supplied email.
   */
  abstract resendVerification(email: string): Promise<void>

  /**
   * Create a Sign-in session after a verified Account presents the Password.
   * Unknown emails and wrong Passwords share one failure so the call cannot
   * enumerate Accounts. An Unverified Account with the correct Password is a
   * distinct failure. A Banned Account with the correct Password is `banned`.
   * @param email - visitor-supplied email.
   * @param password - visitor-supplied Password.
   * @returns a Sign-in session id on success.
   */
  abstract signIn(email: string, password: string): Promise<SignInResult>

  /**
   * End one Sign-in session. Unknown ids are a no-op.
   * @param signInId - the id the browser presented.
   */
  abstract signOut(signInId: SignInSessionId): Promise<void>

  /**
   * Resolve a presented Sign-in session id to the owning Account. A live
   * Sign-in session is slid forward by the configured lifetime.
   * @param signInId - the id the browser presented.
   * @returns the live Sign-in session, or `undefined` when it is unknown,
   *   expired, or the Account is Banned.
   */
  abstract lookupSignIn(signInId: SignInSessionId): Promise<SignInLookup | undefined>

  /**
   * Send a password-reset message when the email belongs to a verified Account.
   * Unknown or Unverified addresses are a silent success so the call cannot
   * enumerate Accounts.
   * @param email - visitor-supplied email.
   */
  abstract requestPasswordReset(email: string): Promise<void>

  /**
   * Consume a single-use password-reset token, set a new Password, and end
   * every Sign-in session for that Account. A Banned Account may still change
   * the Password; `signIn` stays `banned` until the Ban is lifted.
   * @param token - raw token from the password-reset URL.
   * @param password - visitor-supplied new Password.
   * @returns whether the Password was changed.
   */
  abstract resetPassword(token: string, password: string): Promise<ResetPasswordResult>

  /**
   * Ban an Account by email. Sign-in and live Sign-in sessions stop; the
   * Account row remains. Idempotent when already Banned. HTTP Operator
   * routes are the authorization check; this method does not consult the
   * operator list.
   * @param email - target Account email.
   * @returns `{ ok: true }` when the Account exists, or `not_found`.
   */
  abstract ban(email: string): Promise<BanResult>

  /**
   * Lift a Ban. Idempotent when the Account is not Banned. Leftover Sign-in
   * sessions for that Account end so a raced insert cannot become live.
   * @param email - target Account email.
   * @returns `{ ok: true }` when the Account exists, or `not_found`.
   */
  abstract liftBan(email: string): Promise<BanResult>

  /**
   * Erase this Account row and CASCADE Sign-in sessions, verification tokens,
   * password-reset tokens, and executing-world usage rows. Does not Ban. The
   * HTTP Consumer erases Sessions, Workspaces, and Credentials before calling
   * this. Unknown ids are `not_found`.
   * @param id - opaque Account id of the signed-in caller.
   * @returns `{ ok: true }` when the row was deleted, or `not_found`.
   */
  abstract deleteAccount(id: AccountId): Promise<DeleteResult>

  /**
   * Freeze or unfreeze public registration. Frozen `register` returns
   * `registration_frozen` and does not insert a row.
   * @param frozen - whether new registration is refused.
   */
  abstract setRegistrationFrozen(frozen: boolean): Promise<void>

  /**
   * Whether public registration is frozen.
   * @returns true when `register` must return `registration_frozen`.
   */
  abstract isRegistrationFrozen(): Promise<boolean>

  /**
   * Look up an Account by email for Operator access. Returns existence,
   * verified, and Ban flags with no Session bodies. Unknown emails are
   * `undefined`. HTTP Operator routes are the authorization check.
   * @param email - target Account email.
   * @returns the summary, or `undefined` when no Account exists.
   */
  abstract lookupByEmail(email: string): Promise<AccountLookup | undefined>

  /**
   * Look up an Account by id, including Banned Accounts. Used to stamp
   * audit rows after email lookup has already authorized the opening.
   * @param id - opaque Account id.
   * @returns the summary, or `undefined` when no Account exists.
   */
  abstract lookupById(id: AccountId): Promise<AccountLookup | undefined>

  /**
   * Append one Operator-access opening. HTTP Operator routes authorize;
   * this method does not consult the operator list.
   * @param entry - Operator, target Account, optional Session, and time.
   * @returns the persisted row including its id.
   */
  abstract recordOperatorAccess(entry: OperatorAuditWrite): Promise<OperatorAuditRecord>

  /**
   * List Operator-access openings, newest first.
   * @returns every audit row.
   */
  abstract listOperatorAccess(): Promise<OperatorAuditRecord[]>

  /**
   * Open a sandbox-running interval for this Account. A leftover open interval
   * is closed at `at` first. Does not enforce the daily cap.
   * @param accountId - owning Account.
   * @param at - interval start, milliseconds since Unix epoch.
   * @returns `at`, the token later passed to {@link endExecutingWorld}.
   */
  abstract beginExecutingWorld(accountId: AccountId, at: number): Promise<number>

  /**
   * Close the sandbox-running interval identified by `startedAt` and add the
   * elapsed time to each overlapped UTC day. A missing or already-replaced
   * interval is a no-op.
   * @param accountId - owning Account.
   * @param startedAt - token returned by {@link beginExecutingWorld}.
   * @param at - interval end, milliseconds since Unix epoch.
   */
  abstract endExecutingWorld(accountId: AccountId, startedAt: number, at: number): Promise<void>

  /**
   * Sandbox-running milliseconds already charged to this Account on the UTC
   * day that contains `at`, including a still-open interval.
   * @param accountId - owning Account.
   * @param at - instant whose UTC day is queried, milliseconds since Unix epoch.
   * @returns milliseconds used on that UTC day.
   */
  abstract executingWorldUsedMs(accountId: AccountId, at: number): Promise<number>
}

export default Accounts
