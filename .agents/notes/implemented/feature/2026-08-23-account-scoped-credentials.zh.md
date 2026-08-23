# Agent Note: 按 Account 隔离的 Credentials 与 prompt 拒绝

Status: implemented

[English](2026-08-23-account-scoped-credentials.md) | 中文

## 问题

托管 Credentials 存在于一份进程级 `$DSH_HOME/.credentials.yaml`（以及启动环境）里。两个 Sign-in session 会读写同一份机密。`credentials.*` 写入的授权是 loopback same-origin。没有 Credential 的 Account 仍可发送 Session 消息，随后在 LLM 适配器里失败——或用上另一 Account 的密钥。

## 决策

托管 bundle 把 `credentials` 行替换为 `dsh-credentials-account`。每个已登录 Account 拥有 `$DSH_HOME/credentials/<accountId>.json`。进程环境不是一层来源。`resolve` 按次调用，因此 Models 页的写入无需重启即可作用于下一次请求。写入要求 Sign-in session 通过 `currentAccountId()` 绑定。

当组合了 `ctx.accounts` 时，`credentials.describe`／`set`／`unset` 不再钉在 loopback；`/api` 已经要求的 Sign-in session 就是授权。不含 Accounts 的本地 `dsh web` 仍钉 loopback。

托管 `session.prompt` 与 `subagent.prompt` 在 Session 可见性检查之后，若 `hasStoredSecret()` 为 false，以 `credential-missing` 拒绝。登录、`/auth/me` 以及 `session.list`／`session.create` 仍可用。

## 曾考虑的替代方案

**保留 credentials-local，按 Account 给 key 加前缀。** 不予采纳，因为继承环境仍会优先，并把平台密钥共享给所有 Account（ADR 0003）。

**Credentials 存 PostgreSQL 行。** 不予采纳，因为 ADR 0017 不把机密放入 PostgreSQL；沿用现有 Credential 文档模型，只是按 Account 分文件。

**只在 LLM 适配器里拒绝。** 不予采纳，因为 Session 消息会被先接受；产品规则是发送即拒绝。

## 后果

带两个 cookie jar 的 HTTP 测试是真相来源。Workspace、Ban 和 Operator access 仍属后续工单。本地 `dsh web` 仍使用 `dsh-credentials-local`。

## 必要验证

HTTP：两个 jar 隔离 `credentials.describe`／`set`；没有 Credential 的 jar 仍可登录、列出并创建 Session，且 `session.prompt`／`subagent.prompt` 在该 jar 保存 Credential 之前为 `credential-missing`，之后不再是。Connection：组合了 Accounts 时，受信任 host 上的 `credentials.*` 在无 cookie 时为 401、有 cookie 时不是 403；`settings.describe` 仍为 403。
