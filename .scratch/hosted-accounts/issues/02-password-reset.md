## Parent

https://github.com/sishierdianyijiuwu/deepseek/issues/1

## What to build

An Account can reset the Password via the verified email. Reset ends every Sign-in session. A live Sign-in session lasts 14 days and slides forward on use. Closing the browser does not sign the Account out.

## Acceptance criteria

- [ ] A verified Account can request a password-reset email
- [ ] A valid reset link sets a new Password and cannot be reused
- [ ] After reset, every existing Sign-in session for that Account is ended
- [ ] A Sign-in session lasts 14 days and slides forward on authenticated use
- [ ] Closing the browser does not end the Sign-in session
- [ ] A Banned Account cannot restore sign-in via password reset (if Ban exists, skip until Ban ships; then this still holds)
- [ ] HTTP tests use a fake mailer and a fake clock

## Blocked by

- Ticket 1: Register, verify email, sign in, sign out
