## Parent

https://github.com/sishierdianyijiuwu/deepseek/issues/1

## What to build

Operator emails come from environment configuration. An Operator can Ban an Account (sign-in stops, data remains) and lift a Ban, and can freeze or unfreeze public registration. This slice does not open other people’s Sessions.

## Acceptance criteria

- [ ] Only emails on the operator list are Operators; the first registrant is not special
- [ ] Ban prevents sign-in; Sessions, Workspaces, and Credentials remain
- [ ] Lifting a Ban allows sign-in again
- [ ] Password reset does not restore sign-in for a Banned Account
- [ ] An Operator can disable and re-enable registration
- [ ] Ordinary Accounts cannot Ban or freeze registration
- [ ] HTTP tests cover Ban and freeze without reading another Account’s Session body

## Blocked by

- Ticket 1: Register, verify email, sign in, sign out
