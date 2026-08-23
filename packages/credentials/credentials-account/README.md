# @deepseek-ai/dsh-credentials-account

English | [中文](README.zh.md)

Account-scoped [credentials](../credentials/README.md) provider for the hosted control plane. Each signed-in Account has its own `$DSH_HOME/credentials/<accountId>.json` document. The process environment is not a layer: a platform key would be shared across Accounts. `resolve` is per call, so Settings → Models writes take effect on the next LLM request without a process restart.

Writes (`set` / `unset` / `modifyRecord` / `deleteRecord`) require `currentAccountId()` from the Sign-in session. A call with no bound Account describes the reference as unconfigured and unwritable, and `resolve` returns `undefined` rather than another Account's secret.

## Config

| Field | Default | Meaning |
|---|---|---|
| `dshHome` | `$DSH_HOME` or `~/.dsh` | Harness home that contains the `credentials/` directory. |

## Model Experience

Indirectly, through the consuming LLM adapters: a resolved value authorizes their provider requests, and the adapter owns every model-visible surface.

#### KV Cache effect

No direct invalidation; credentials never enter a request prefix.

## Known Limitations and Deferred Work

- **References are not enumerated** — the seam has no `list()` over refs; `hasStoredSecret()` answers presence from the Account document instead.
