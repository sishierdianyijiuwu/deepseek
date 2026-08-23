# @deepseek-ai/dsh-account

English | [中文](README.zh.md)

Service Definition for `ctx.accounts`. An Account is identified by a normalized email and a one-way Password hash. Registration creates an Unverified Account; `verifyEmail` consumes a single-use token; `signIn` mints a Sign-in session id after the email is verified; `signOut` ends that id; `lookupSignIn` resolves it, slides its lifetime, reports `operator` when the email is on the host operator list, and returns `undefined` when the Account is Banned. `requestPasswordReset` mails a single-use token to a verified Account (unknown or Unverified addresses are a silent success). `resetPassword` sets a new Password, consumes the token, and ends every Sign-in session for that Account; a Banned Account may still change the Password, and `signIn` stays `banned` until the Ban is lifted. `register` returns `mail_failed` when the Unverified Account row exists but the mailer rejected the send, and `registration_frozen` when an Operator has disabled public registration. Unknown emails and wrong Passwords share `invalid_credentials` so sign-in cannot enumerate Accounts. A Banned Account with the correct Password is `banned`. `ban` / `liftBan` set or clear Ban without deleting the Account row. `deleteAccount` erases the Account row (Sign-in sessions CASCADE); it is not a Ban. `setRegistrationFrozen` / `isRegistrationFrozen` control public registration. `lookupByEmail` / `lookupById` return existence, verified, and Ban flags with no Session bodies. `recordOperatorAccess` / `listOperatorAccess` persist the Operator-access audit log. `beginExecutingWorld` / `endExecutingWorld` / `executingWorldUsedMs` persist sandbox-running time per Account per UTC day; `beginExecutingWorld` returns the `started_at` token and `endExecutingWorld` closes only that interval. Helpers `hashPassword`, `normalizeEmail`, and `mintSecret` are the hashing and identity rules every provider must use.

The HTTP cookie and PostgreSQL rows are owned by Consumers and providers. `SIGN_IN_COOKIE`, `cookieValue`, `runWithAccount`, and `currentAccountId` bind the signed-in Account for Host `/api` Session isolation. `OPERATOR_ACCESS_HEADER`, `runWithOperatorAccess`, `currentOperatorAccess`, and `viewingAccountId` bind read-only Operator access to another Account; Credential resolution still uses the signed-in Operator. Anonymous identity is not an Account id. Operator authorization for Ban, freeze, lookup, and audit is the HTTP Consumer checking `SignInLookup.operator`.

## Model Experience

None, as Account identity is a control-plane concern and never enters a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **A Banned Account cannot perform Deletion** — `lookupSignIn` is `undefined`, so the HTTP route is `forbidden`; Ban keeps the row for audit.
