## Parent

https://github.com/sishierdianyijiuwu/deepseek/issues/1

## What to build

Host `/api` requires a Sign-in session. Sessions are owned by the signed-in Account. Two Accounts never see each other’s Session lists, prompts, or live event streams. Do not ship “signed in but global session list”.

## Acceptance criteria

- [ ] Unauthenticated `/api` Session methods are rejected
- [ ] `session.create` attaches the Session to the signed-in Account
- [ ] `session.list`, lookup, search, export, and mux subscribe return only that Account’s Sessions
- [ ] Opening another Account’s Session id fails as not found (no cross-Account probe)
- [ ] Two cookie jars (two Accounts) cannot prompt or watch each other’s Sessions
- [ ] Static/auth routes still work without a Sign-in session
- [ ] HTTP tests with two Accounts are the source of truth

## Blocked by

- Ticket 1: Register, verify email, sign in, sign out
