# @deepseek-ai/dsh-account

English | [中文](README.zh.md)

Service Definition for `ctx.accounts`. An Account is identified by a normalized email and a one-way Password hash. Registration creates an Unverified Account; `verifyEmail` consumes a single-use token; `signIn` mints a Sign-in session id after the email is verified; `signOut` and `lookupSignIn` end or resolve that id. `register` returns `mail_failed` when the Unverified Account row exists but the mailer rejected the send. Unknown emails and wrong Passwords share `invalid_credentials` so sign-in cannot enumerate Accounts. Helpers `hashPassword`, `normalizeEmail`, and `mintSecret` are the hashing and identity rules every provider must use.

The HTTP cookie and PostgreSQL rows are owned by Consumers and providers. `SIGN_IN_COOKIE`, `cookieValue`, `runWithAccount`, and `currentAccountId` bind the signed-in Account for Host `/api` Session isolation. Anonymous identity is not an Account id.

## Model Experience

None, as Account identity is a control-plane concern and never enters a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No password reset or Ban** — later tickets own reset tokens, sliding Sign-in lifetime, and Operator Ban.
