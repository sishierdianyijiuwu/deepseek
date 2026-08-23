# @deepseek-ai/dsh-client-ui-account

English | [中文](README.zh.md)

Browser overlay for register, email verification, sign-in, and sign-out. Occupies `shell.overlay` as `account-gate`. Until `/auth/me` reports a Sign-in session, it takes over the viewport; afterwards it shows a signed-in chip with sign-out. Verification links land on the named host route `/verify` and redirect to `/?verified=ok` or `/?verified=invalid`, which this overlay reads. The `account` namespace ships Chinese and English, with `zh` as the key-set source of truth. Unverified sign-in, `email_taken` register, and `mail_failed` register all offer resend. Composed by the hosted profile, not by local `dsh web`.

## Model Experience

None, as the browser Account gate registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No password-reset screen** — later tickets add reset.
- **Does not occupy `root`** — the layout frame stays mounted; the overlay covers it until sign-in.
