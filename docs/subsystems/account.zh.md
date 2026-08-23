# Account

[English](account.md) | 中文

托管 Account 能力：`ctx.accounts` 持久化 Account 与 Sign-in session 行；`ctx.mailer` 投递验证与密码重置邮件。产品词汇见 [CONTEXT.md](../../CONTEXT.md)。HTTP 路由在 [`dsh-account-http`](../../packages/account/account-http/README.zh.md)。

来源：[`packages/account/account/src/index.ts`](../../packages/account/account/src/index.ts)

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxaccounts--accounts-abstract-seam"></a>

### `ctx.accounts` — `Accounts` (abstract seam)

Abstract Account service. Subclass, implement the methods, and load the subclass as a plugin — it registers as `ctx.accounts`.

```ts cordis-catalog
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
```

Source: [`packages/account/account/src/index.ts`](../../packages/account/account/src/index.ts)

<a id="ctxmailer--mailer-abstract-seam"></a>

### `ctx.mailer` — `Mailer` (abstract seam)

Abstract mailer. Subclass and load the subclass as a plugin — it registers as `ctx.mailer`.

```ts cordis-catalog
/**
 * Deliver one message.
 * @param message - recipient, subject, and plain-text body.
 */
abstract send(message: MailMessage): Promise<void>
```

Source: [`packages/account/mailer/src/index.ts`](../../packages/account/mailer/src/index.ts)
<!-- END GENERATED cordis-surface -->
