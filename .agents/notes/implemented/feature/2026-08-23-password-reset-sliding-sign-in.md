# Agent Note: Password reset and 14-day sliding Sign-in session

Status: implemented

English | [中文](2026-08-23-password-reset-sliding-sign-in.zh.md)

## Problem

A verified Account that forgot the Password has no recovery path. A Sign-in session that does not slide logs the Account out every 14 days of calendar time even when they use the product, and a session cookie would sign them out when the browser closes. A stolen cookie would also survive a password change unless reset ends every Sign-in session for that Account. Ban does not exist yet, so reset cannot consult it. Ticket #4 binds `/api` in a different worktree; sliding must not wait for Session methods.

## Decision

Password reset and sliding lifetime live on the existing Account seam ([packages](../architecture/2026-08-23-account-mailer-postgres-seam.md)).

`requestPasswordReset(email)` is a silent success for unknown, Unverified, or invalid addresses so the HTTP route cannot enumerate Accounts. A verified Account gets a single-use SHA-256-stored token with `passwordResetTtlMs` (default 1 hour); a later request deletes the previous token. Mailer failure on that send is also silent. `resetPassword(token, password)` rejects a short Password without consuming the token, rejects an unknown or expired token as `invalid_or_expired`, and on success replaces the Password hash, deletes that Account's reset tokens, and deletes every Sign-in session row.

`GET /reset?token=` is a named host route because `frontend-static` 404s unknown pathnames. HEAD returns 200 and does not consume the token (mail scanners). GET redirects to `/?reset=<token>` without consuming it; the overlay POSTs `/auth/reset-password`. A successful reset clears the `dsh_sign_in` cookie.

`lookupSignIn` slides a still-valid Sign-in session to `now + signInTtlMs` (default 14 days) in one `UPDATE … RETURNING`. `/auth/me` then refreshes cookie `Max-Age` so the browser expiry tracks the server. Closing the browser does not end the Sign-in session: the cookie always carries `Max-Age`, never a session-cookie omission. Sliding is not attached to `/api` Session methods.

HTTP tests spy `Date.now` as the fake clock and keep the fake Mailer subclass.

## Alternatives considered

**A Clock capability seam (`ctx.clock`).** Rejected: the only consumer is Account time, and a one-role seam is forbidden. Spying `Date.now` in the Loader-composed HTTP process is the same kind of fake as the Mailer subclass, without a new `ctx` key.

**Slide only inside `/auth/me` and leave `lookupSignIn` as a pure read.** Rejected: every authenticated use that resolves the cookie must slide, including later `/api` lookups that will call `lookupSignIn`. Putting the slide in the lookup keeps one write.

**Session cookie (no `Max-Age`).** Rejected by ADR 0013: closing the browser must not end the Sign-in session.

**Consume the reset token on GET `/reset`.** Rejected: mail scanners GET mailbox links. Verification consumes on GET because it needs no extra input; reset needs a new Password, so only POST consumes.

**Create a Sign-in session on successful reset.** Rejected: the spec ends every Sign-in session so a stolen cookie dies with the old Password; the Account signs in again with the new Password.

## Testing

Loader-composed HTTP with PGlite, a fake mailer, and a fake `Date.now` clock pins: verified request sends mail; unknown/Unverified/mailer-fail stay silent; a valid token sets a new Password and cannot be reused; two cookie jars both fail `/auth/me` after reset; `/auth/me` after 13 idle days still signs in and refreshes `Max-Age`; 14 idle days without a lookup expires; `Max-Age` is present on sign-in so the cookie is not a session cookie. Overlay tests pin forgot/reset screens and the `/?reset=` landing.

## Consequences

Recovery and sliding exist without Ban and without binding `/api` to a Sign-in session. Ban, when it ships, must refuse reset that would restore sign-in. Schema version is 2; a v1 control-plane database fails at load. Ticket #4 can call `lookupSignIn` and inherit the slide.
