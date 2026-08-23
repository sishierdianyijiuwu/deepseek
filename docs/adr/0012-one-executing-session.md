# One executing Session per Account

An Account may have many Sessions, but only one executing Session at a time. Parallel E2B sandboxes were rejected: the host pays for E2B, and two writers would race the durable Workspace copy on the control plane.

Multiple browser tabs may view the same executing Session. Starting a second executing Session is refused until the first stops.

**Status**: accepted
