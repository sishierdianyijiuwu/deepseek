## Parent

https://github.com/sishierdianyijiuwu/deepseek/issues/1

## What to build

Each Account may use 60 minutes of execution-world time per UTC day. Exhaustion refuses a new Executing Session. The Account can still sign in, read history, and change Credentials. Idle history viewing does not burn the cap.

## Acceptance criteria

- [ ] Sandbox-running time counts toward 60 minutes per Account per UTC day
- [ ] Reading history or changing Credentials does not consume the cap
- [ ] When the cap is exhausted, a new Executing Session is refused
- [ ] Sign-in and Session reads still work after exhaustion
- [ ] HTTP tests fake the clock to roll the UTC day and the E2B SDK

## Blocked by

- Ticket 7: E2B hydrate, copy-back, one Executing Session
