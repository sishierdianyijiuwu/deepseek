# Agent Note: Operator Ban and registration freeze

Status: implemented

[English](2026-08-23-operator-ban-and-registration-freeze.md) | 中文

## 问题

公开注册页不能把第一个 Account 当成 Operator：那种抢注不安全。宿主仍需要在不销毁 Session、Workspace 或 Credential 的情况下阻止滥用者登录，以及在不关掉站点的情况下停止新注册。密码重置不得撤销该阻止。普通 Account 不得获得这些操作。本切片不得打开另一个 Account 的 Session 正文。

## 决策

Operator 身份是 `dsh-account-postgres` 上的配置邮箱列表（`operatorEmails`，托管为 `DSH_OPERATOR_EMAILS`）。邮箱在加载时规范化；无效项会大声失败；空列表表示没有 Operator。首位注册者并不特殊。规范化邮箱在该列表上的 Account，走完普通的注册／验证／登录流程后就是 Operator。`lookupSignIn` 报告 `operator`。

Ban 是 `accounts.banned_at`。`ban(email)` 设置它（幂等）并删除该 Account 的每一个 Sign-in session；Account 行保留。出示正确 Password 的 `signIn` 返回 `banned`。`lookupSignIn` 拒绝 Banned Account。`liftBan(email)` 清除 `banned_at`（幂等）。密码重置仍可替换 Password；在解除之前 `signIn` 仍为 `banned`。

注册冻结是单例 `registration_control.frozen_at`。冻结时 `register` 返回 `registration_frozen` 且不插入行。

HTTP Operator 路由落在现有鉴权 Consumer 上、`/api` 旁边：

| 方法 | 路径 |
|---|---|
| POST | `/auth/operator/ban` |
| POST | `/auth/operator/lift-ban` |
| POST | `/auth/operator/freeze-registration` |
| GET | `/auth/operator/registration` |

它们要求有效 Sign-in session 且 `operator: true`。未认证调用方和普通 Account 在 HTTP 200 收到 `{ ok: false, error: { code: 'forbidden' } }`。这些路由不读取 Session 日志。schema 版本为 `SCHEMA_VERSION = 3`。

## 曾考虑的替代方案

**首位注册者就是 Operator。** 被 ADR 0004 否决：公开注册页不得靠抢注授予 Operator。

**Ban 时删除 Account。** 被 ADR 0014 否决：Ban 必须保留证据；Deletion 是后续的自助操作。

**单独的 Operator 登录或角色表。** 否决：Operator 不是另一种登录。环境列表加上现有的邮箱+密码流程就是产品规则。

**把 Ban 和冻结放到 Host `/api` RPC。** 否决：未认证旁路的 Account HTTP 已经在 `/api` 旁边拥有注册／登录。不打开 Session 的 Operator 操作留在该 Consumer 上。

**拒绝 Banned Account 的密码重置。** 否决：验收要求是重置不得恢复登录。在 Ban 仍然有效时改 Password，`signIn` 仍为 `banned`。

**内存中的冻结标志。** 否决：ADR 0017 把注册冻结放在 PostgreSQL，因此重启不会重新打开注册。

## 测试

带 PGlite、假邮件发送和两个 cookie jar 的 Loader 组合 HTTP 钉住：首位注册者不是 Operator；只有 `operatorEmails` 能 Ban、解除、冻结和解冻；普通和未认证调用方得到 `forbidden`；Ban 结束有效 cookie 且 `signIn` 返回 `banned`；再次注册是 `email_taken`；解除后恢复登录；冻结返回 `registration_frozen`，解冻后允许注册；Ban 之后的重置在解除前仍让 `signIn` 为 `banned`。测试不调用 `/api`，也不读取 Session 正文。

## 后果

Operator 可以 Ban 和冻结，而无需 Operator Session 访问（后续工单），也无需 Deletion。空的 `DSH_OPERATOR_EMAILS` 使宿主没有任何 Operator。若 Ban 针对仅剩的 Operator 邮箱，该 Operator 会被锁在外面，直到修改环境列表并编辑数据库才能恢复。
