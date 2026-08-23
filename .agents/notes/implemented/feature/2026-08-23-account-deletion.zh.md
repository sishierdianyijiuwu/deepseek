# Agent Note: Account Deletion

Status: implemented

[English](2026-08-23-account-deletion.md) | 中文

## Problem

离开托管产品的人需要在没有 Operator 的情况下抹除自己的 Account，而安全 Ban 必须保留 Session、Workspace 和 Credential 以供审计。把两者收成一个动作，要么毁掉证据，要么让每一次离开都经过 Operator。

## Decision

Deletion 是已登录 Account 的自助操作。`POST /auth/delete` 要求有效 Sign-in session，调用 `accounts.deleteAccount(accountId)` 以 `DELETE` PostgreSQL Account 行（验证令牌、密码重置令牌和 Sign-in session CASCADE），再抹除该 Account 的云 Workspace（`deleteAllOwned`）、Credential 文档（`eraseOwned`）和已持久化 Session 日志（`deleteOwned`）。cookie 被清除。Ban 仍是单独的、不抹除的 Operator 动作：`banned_at` 保留，`register` 返回 `email_taken`，Operator access 仍可读该 Account。

Deletion 之后，同一邮箱可以注册为带新 id 的新 Account。其他 Account 的行、文件和日志不会被选中。Operator 删除自己的 Account 走同一路由、同一 owner 过滤。

Banned Account 不能执行 Deletion：`lookupSignIn` 返回 `undefined`，因此该路由为 `forbidden`。

## Alternatives considered

**仅 Operator 可 Deletion。** 否决，因为离开的人不得需要 Operator，且 Operator 删除他人与自助不是同一种授权。

**软删除 `deleted_at` 列。** 否决，因为该邮箱必须能再次注册，而需要保留证据时 Ban 已经保留该行。`SCHEMA_VERSION` 仍为 4；Deletion 是 `DELETE`，不是新列。

**一个动作同时 Ban 并抹除。** 否决：安全 Ban 不得毁掉证据，Deletion 也不得需要 Operator。

**在 `PostgresAccounts` 内做级联。** 否决，因为 Session、Workspace 和 Credential 属于其他 seam。HTTP Consumer 编排可选的 `ctx.get` 对等方，因此仅鉴权的组合仍会删除 Account 行。

## Consequences

已删除 Account 的内存中 live Session 因 owner 不匹配而对 HTTP 不可见；此处不加锁 Executing Session。`operator_audit_log` 没有外键，因此 Deletion 之后打开记录仍在。

## Testing

HTTP 测试对照 Deletion 与 Ban：只有被删除 Account 的自有 Workspace 文件、Credential 文档、Session 列表和 JSONL 日志消失；Ban 会留下它们；该邮箱可以再次注册；Operator 删除自己不会动其他 Account。包测试覆盖 `deleteAccount`、`deleteAllOwned`、`eraseOwned` 以及 JSONL／SQLite 的 `deleteOwned`。
