## Parent

https://github.com/sishierdianyijiuwu/deepseek/issues/1

## What to build

An Account can delete itself. Deletion erases that Account, its Sessions, Workspaces, Credentials, and Sign-in sessions. It does not erase other people’s data. Ban remains a separate, non-erasing action.

## Acceptance criteria

- [ ] A signed-in Account can perform Deletion
- [ ] After Deletion, that email can register again as a new Account
- [ ] Sessions, Workspace files, Credentials, and Sign-in sessions of the deleted Account are gone
- [ ] Other Accounts’ data is untouched
- [ ] Operator Deletion of their own Account does not remove other Accounts’ data
- [ ] Ban still does not erase data
- [ ] HTTP tests cover Deletion vs Ban

## Blocked by

- Ticket 3: Signed-in Account owns Sessions
- Ticket 4: Account-scoped Credentials
- Ticket 5: Cloud empty Workspaces
