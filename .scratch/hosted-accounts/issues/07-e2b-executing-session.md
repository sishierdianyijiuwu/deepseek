## Parent

https://github.com/sishierdianyijiuwu/deepseek/issues/1

## What to build

Tools run in an E2B execution world paid by the host’s one API key. Durable Workspace files are copied into the sandbox when an Executing Session starts, copied back after each turn and when it ends. An Account may have only one Executing Session at a time. Multiple tabs may view that Session.

## Acceptance criteria

- [ ] Tool filesystem and bash run in E2B, not as the control-plane OS user
- [ ] The platform E2B key is never installed inside the sandbox
- [ ] Starting an Executing Session hydrates the Account’s durable Workspace into the sandbox
- [ ] Copy-back runs after each turn and when the Executing Session ends
- [ ] Copy-back that would exceed 1 GiB fails visibly and does not grow the durable copy past the cap
- [ ] E2B sandbox expiry does not delete the durable Workspace
- [ ] A second Executing Session is refused until the first stops
- [ ] Extra tabs can view the same Executing Session
- [ ] HTTP tests fake the E2B SDK

## Blocked by

- Ticket 4: Account-scoped Credentials
- Ticket 5: Cloud empty Workspaces
