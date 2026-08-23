# Agent Note: Operator read-only access and audit log

Status: implemented

[English](2026-08-23-operator-readonly-audit.md) | 中文

## Problem

Operator 可以为支持或审计打开另一 Account 的 Session 与 Workspace 文件，包括 Ban 之后。普通 Account 隔离仍必须成立。冒充会让 Operator 以该 Account 的身份 prompt 并在其执行世界里跑工具。没有持久审计行，这些打开无法被重建。

## Decision

Operator 查找是 GET `/auth/operator/account?email=`。它返回存在性、已验证和 Banned，不含 Session 正文。GET `/auth/operator/audit` 列出打开记录，最新在前。两者都要求 `SignInLookup.operator`；普通 Account 和未认证调用方得到 `{ ok: false, error: { code: 'forbidden' } }`。

打开使用 Host `/api` 和事件 WebSocket，请求头 `x-dsh-operator-access` 设为目标邮箱。`dsh-client-connection` 解析该邮箱，绑定 `runWithOperatorAccess`，并让 `currentAccountId` 仍为 Operator。`viewingAccountId` 是目标，因此 session list/history/search/export、mux/host 帧、workspace list、`workspace.listFiles` 和 `workspace.read` 看到该 Account。非 Operator 出示该头为 HTTP 403。未知目标邮箱被忽略（Operator 看到自己的 Account）。Ban 不向 Operator access 隐藏目标。

Operator access 下的 prompt、session/workspace 变更以及 `credentials.describe` / `set` / `unset` 返回 `operator-access-readonly`。`respond` 为 `not-pending`。Mux 套接字仍只下行：客户端消息以 1008 关闭套接字。Credential 解析仍使用 Operator Account id，因此目标的密钥绝不是绑定的存储。

每一次打开都会追加 `operator_audit_log`（schema 版本 4）：Operator Account id 与邮箱、目标 Account id、可选 Session id，以及 `opened_at`。Account 级读取（list、mux、Workspace 文件）省略 `session_id`；Session 日志读取（history、attachment、export）带上它。

## Alternatives considered

**通过把 `currentAccountId` 设为目标来冒充。** 被 ADR 0005 否决：Credential resolve 与 session.create 就会以该 Account 运行。

**用专用 `/auth/operator/session-log` 转储代替 `/api`。** 否决：mux 与 `session.history` 才是产品 Session 日志；第二套转储会漂移。查找与审计留在 `/auth`，因为它们不打开 Session 正文。

**只审计显式 open RPC。** 否决：每一次成功读取另一 Account 的 Session 或文件都是必须可重建的打开。

**Operator 按邮箱查找时跳过审计行。** 保留：查找是不含会话正文的存在性查询，因此不是打开。

## Testing

带 PGlite、两个普通 cookie jar 和一个 Operator jar 的 Loader 组合 HTTP 钉住：按邮箱查找且无正文；普通和未认证查找为 `forbidden`；带该头的 Operator `session.list` / `history` / `workspace.listFiles` / `workspace.read` 看到目标；普通 jar 不能列出或打开该 Session；prompt、workspace 写入和 Credential describe/set 为 `operator-access-readonly`；带该头的 mux 在客户端消息上关闭；审计行点名 Operator 以及 Account 或 Session；Ban 之后 Operator 仍可读。进程内 ApiProxy 通过 `runWithOperatorAccess` 钉住同一套读取／拒绝划分。

## Consequences

Operator 可以支持或审计，而不冒充。Schema 版本 4 没有兼容路径。若 Operator Ban 了自己的邮箱，会失去 Sign-in session，在修改环境列表并编辑数据库恢复之前无法再打开访问。
