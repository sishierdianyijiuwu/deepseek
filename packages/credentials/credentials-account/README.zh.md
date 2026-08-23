# @deepseek-ai/dsh-credentials-account

[English](README.md) | 中文

托管控制面的按 Account 隔离的[凭据](../credentials/README.zh.md)提供方。每个已登录 Account 拥有自己的 `$DSH_HOME/credentials/<accountId>.json` 文档。进程环境不是一层来源：平台密钥会在 Account 之间共享。`resolve` 按次调用，因此 Settings → Models 的写入会在下一次 LLM 请求生效，无需重启进程。

写入（`set` / `unset` / `modifyRecord` / `deleteRecord`）要求 Sign-in session 通过 `currentAccountId()` 绑定 Account。没有绑定 Account 的调用把该引用描述为未配置且不可写，`resolve` 返回 `undefined`，而不是另一 Account 的机密。`eraseOwned(accountId)` 在没有绑定 Sign-in session 时删除该 Account 的文档，因此 Account Deletion 能在 Sign-in session 已经结束后丢掉该文件。

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | 含 `credentials/` 目录的 Harness home。 |

## Model Experience

Indirectly, through the consuming LLM adapters: a resolved value authorizes their provider requests, and the adapter owns every model-visible surface.

#### KV Cache effect

No direct invalidation; credentials never enter a request prefix.

## Known Limitations and Deferred Work

- **引用不可枚举** — seam 没有针对 refs 的 `list()`；`hasStoredSecret()` 改为从该 Account 的文档回答是否存在。
