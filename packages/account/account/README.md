# @deepseek-ai/dsh-account

English | [中文](README.zh.md)

Service Definition for `ctx.accounts`. An Account is identified by a normalized email and a one-way Password hash. Registration creates an Unverified Account; `verifyEmail` consumes a single-use token; `signIn` mints a Sign-in session id after the email is verified; `signOut` ends that id; `lookupSignIn` resolves it and slides its lifetime. `requestPasswordReset` mails a single-use token to a verified Account (unknown or Unverified addresses are a silent success). `resetPassword` sets a new Password, consumes the token, and ends every Sign-in session for that Account. `register` returns `mail_failed` when the Unverified Account row exists but the mailer rejected the send. Unknown emails and wrong Passwords share `invalid_credentials` so sign-in cannot enumerate Accounts. Helpers `hashPassword`, `normalizeEmail`, and `mintSecret` are the hashing and identity rules every provider must use.

The HTTP cookie and PostgreSQL rows are owned by Consumers and providers. Anonymous identity is not an Account id.

## Model Experience

None, as Account identity is a control-plane concern and never enters a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No Ban** — Operator Ban is a later ticket; password reset does not consult a Ban flag.
- **No Session ownership** — `session.list` is not filtered here; that is a later Account-owned Sessions ticket.
