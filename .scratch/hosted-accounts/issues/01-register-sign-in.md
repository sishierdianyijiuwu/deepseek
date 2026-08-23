## Parent

https://github.com/sishierdianyijiuwu/deepseek/issues/1

## What to build

A visitor can register with email and password, verify the email, sign in, and sign out. The Web UI has those screens. PostgreSQL stores the Account and Sign-in session. The agent is not yet isolated or runnable; this slice only makes an Account real.

## Acceptance criteria

- [ ] Registering with email and password creates an Unverified Account and sends a verification message through the mailer port
- [ ] A duplicate email is rejected
- [ ] An Unverified Account cannot sign in to use Sessions or Workspaces
- [ ] Completing a valid verification link allows sign-in
- [ ] Expired or reused verification links fail clearly
- [ ] Sign-in sets a Sign-in session the browser presents on later requests
- [ ] Sign-out ends that Sign-in session
- [ ] HTTP tests cover the path with a fake mailer (no live SMTP required)

## Blocked by

- None (can start immediately)
