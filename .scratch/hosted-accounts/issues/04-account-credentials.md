## Parent

https://github.com/sishierdianyijiuwu/deepseek/issues/1

## What to build

Model Credentials belong to the signed-in Account. Settings → Models saves that Account’s Credential. An Account with no Credential can sign in but cannot send Session messages. Ordinary Accounts cannot see each other’s Credentials.

## Acceptance criteria

- [ ] Saving a Credential is scoped to the signed-in Account and does not require a process restart
- [ ] Another Account’s Credential is not resolved for LLM calls
- [ ] With no Credential, sign-in and Workspace management still work
- [ ] With no Credential, sending a Session message is refused
- [ ] Loopback is no longer the authorization for Credential writes; the Sign-in session is
- [ ] HTTP tests cover two Accounts and the missing-Credential prompt gate

## Blocked by

- Ticket 3: Signed-in Account owns Sessions
