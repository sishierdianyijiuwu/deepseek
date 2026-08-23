## Parent

https://github.com/sishierdianyijiuwu/deepseek/issues/1

## What to build

An Account can Import a Workspace by cloning a public git HTTPS URL into a new slot they own. Private remotes are rejected. Import counts toward the three-Workspace cap.

## Acceptance criteria

- [ ] Import from a public HTTPS git URL creates a Workspace owned by the Account
- [ ] Import of a private or credential-bearing remote is refused
- [ ] Import into another Account’s tree is impossible
- [ ] Import that would exceed three Workspaces or 1 GiB is refused
- [ ] HTTP tests use a local public git fixture, not the public internet

## Blocked by

- Ticket 5: Cloud empty Workspaces
