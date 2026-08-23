## Parent

https://github.com/sishierdianyijiuwu/deepseek/issues/1

## What to build

An Account creates, lists, and selects empty cloud Workspaces on the control plane instead of a native OS folder picker. At most three Workspaces per Account, 1 GiB each. A Session the Account starts uses a Workspace they own.

## Acceptance criteria

- [ ] The hosted Web UI lists the signed-in Account’s Workspaces, not a native directory picker
- [ ] An Account can create an empty Workspace they own
- [ ] A fourth Workspace is refused
- [ ] A Workspace that would exceed 1 GiB is refused
- [ ] Creating a Session requires a Workspace owned by that Account
- [ ] Another Account cannot list, select, or attach that Workspace
- [ ] Durable files live on the control-plane filesystem, namespaced by Account, not in PostgreSQL blobs
- [ ] HTTP tests cover caps and cross-Account denial

## Blocked by

- Ticket 3: Signed-in Account owns Sessions
