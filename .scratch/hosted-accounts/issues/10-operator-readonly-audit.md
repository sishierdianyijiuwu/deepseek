## Parent

https://github.com/sishierdianyijiuwu/deepseek/issues/1

## What to build

An Operator can open another Account’s Sessions and Workspace files read-only for support or audit, including after Ban. They cannot prompt or run tools as that Account, and cannot read that Account’s Credential secrets. Every opening is written to the audit log.

## Acceptance criteria

- [ ] An Operator can look up an Account by email (existence, verified, Banned) without conversation bodies
- [ ] An Operator can read that Account’s Session log and Workspace files
- [ ] Prompt, tool execution, and Credential secret read under Operator access are refused
- [ ] Event streams in Operator access do not accept prompt or respond
- [ ] Each opening appends an audit log row: which Operator, when, which Account or Session
- [ ] Ordinary Accounts cannot list other Accounts or open their Sessions
- [ ] HTTP tests cover Operator vs ordinary Account

## Blocked by

- Ticket 3: Signed-in Account owns Sessions
- Ticket 9: Operator Ban and freeze registration
