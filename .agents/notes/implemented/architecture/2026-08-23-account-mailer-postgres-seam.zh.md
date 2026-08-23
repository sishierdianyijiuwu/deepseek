# Agent Note: Account、邮件发送与 PostgreSQL 控制面 seam

Status: implemented

[English](2026-08-23-account-mailer-postgres-seam.md) | 中文

## 问题

`CONTEXT.md` 中的托管产品需要访客能够注册 Account、验证邮箱、登录和退出。上游 DeepSeek Harness 是单 home 本地工具：`packages/identity` 是匿名遥测，`packages/credentials` 存放模型提供方密钥，`/api` 信任 loopback，没有邮件发送、没有 PostgreSQL、也没有 Sign-in session。工单 #2 必须让 Account 成为真实对象，但不能隔离 Session 或 Workspace（工单 #4），也不能把本地 `dsh web` 悄悄变成 SaaS。

## 决策

新建 `packages/account/` 组，拥有 Account 与邮件发送能力 seam。本地 `dsh web` 不变。`dsh hosted` / `--profile hosted` 在 base + web-app 之上应用 `@deepseek-ai/dsh-hosted`。

### 包

| 包 | 职责 | `ctx` 键 |
|---|---|---|
| `@deepseek-ai/dsh-account` | Service Definition | `accounts` |
| `@deepseek-ai/dsh-account-postgres` | PostgreSQL Service Provider | `accounts` |
| `@deepseek-ai/dsh-account-http` | HTTP Consumer | — |
| `@deepseek-ai/dsh-mailer` | 邮件发送 Service Definition | `mailer` |
| `@deepseek-ai/dsh-mailer-smtp` | SMTP Service Provider | `mailer` |
| `@deepseek-ai/dsh-client-ui-account` | 浏览器 overlay | — |
| `@deepseek-ai/dsh-hosted` | 托管 profile 组合包 | — |

`packages/identity` 与 `packages/credentials` 不进入此 seam。

### 鉴权 HTTP（在 `/api` 旁边）

未认证路由是具名的 `webServer` 注册，不是 `session.register`，也不是 Typert Remote：

| 方法 | 路径 |
|---|---|
| POST | `/auth/register` |
| POST | `/auth/sign-in` |
| POST | `/auth/sign-out` |
| POST | `/auth/resend-verification` |
| POST | `/auth/request-password-reset` |
| POST | `/auth/reset-password` |
| GET | `/auth/me`（含 `operator`） |
| POST | `/auth/operator/ban` |
| POST | `/auth/operator/lift-ban` |
| POST | `/auth/operator/freeze-registration` |
| GET | `/auth/operator/registration` |
| GET | `/verify`（`HEAD` 返回 200 且不消费令牌） |
| GET | `/reset`（`HEAD` 返回 200 且不消费令牌） |

`GET /verify?token=` 存在，是因为 `frontend-static` 对未知路径返回 404；处理器完成验证后重定向到 `/?verified=ok` 或 `/?verified=invalid`，让 `/` 上的 SPA 展示结果。业务结果的 JSON 为 HTTP 200 的 `{ ok: true }` 或 `{ ok: false, error: { code, message } }`。

### Sign-in session cookie

浏览器通过 HTTP-only cookie `dsh_sign_in`（`Path=/; SameSite=Lax`；带 `Max-Age`，因此关闭浏览器不会结束它；`cookieSecure` 开启时带 `Secure`）出示服务端 Sign-in session id。产品文案仍称 Sign-in session。原始 id 是不可猜测的十六进制；PostgreSQL 存储该 id 的 SHA-256。`lookupSignIn` 把有效的 Sign-in session 按 `signInTtlMs`（默认 14 天）向前滑动；`/auth/me` 刷新 cookie 的 `Max-Age`。密码重置结束该 Account 的每一个 Sign-in session（[滑动与重置](../feature/2026-08-23-password-reset-sliding-sign-in.zh.md)）。

### Password 与令牌

Password 是 scrypt 单向哈希（`scrypt$N$r$p$salt$key`），绝不是 Credential。验证令牌和密码重置令牌是 32 字节密钥，存储为 SHA-256，一次性使用，`verificationTtlMs`（默认 24 小时）与 `passwordResetTtlMs`（默认 1 小时）可配置。重复邮箱由规范化地址上的唯一索引拒绝；并发插入只产生一个 Account。错误 Password 或未知邮箱的失败登录返回相同的 `invalid_credentials`。持有正确 Password 的 Unverified Account 返回 `unverified`，并且不设置 cookie。

### PostgreSQL

ADR 0017：Account 与 Sign-in session 从 v1 起放在 PostgreSQL。配置 `url` 为 `postgres://…` / `postgresql://…`，或 HTTP 测试使用的进程内 PostgreSQL 引擎 `pglite:`。配置 `operatorEmails` 是 Operator 列表（托管 profile：`DSH_OPERATOR_EMAILS`）。schema 版本为 `SCHEMA_VERSION = 3`；不匹配则在加载时失败。`banned_at` 与 `registration_control.frozen_at` 持久化 Ban 和注册冻结。Session JSONL 仍是文件。Ban 与冻结落在这条 seam 上（[Operator Ban](../feature/2026-08-23-operator-ban-and-registration-freeze.zh.md)）。

### 邮件发送

邮件是 mailer 端口（`ctx.mailer.send`）。SMTP 是配置（`dsh-mailer-smtp`）：587 端口在服务器宣告时升级 STARTTLS，未加密套接字上的 AUTH 需要 `allowPlaintextAuth`，隐式 TLS 是 `secure: true`（通常 465 / `DSH_SMTP_SECURE=1`），单次发送受 `timeoutMs` 限制。多行回复等到 `XYZ ` 终结行。若 Unverified Account 行已提交后 mailer 抛出，`register` 返回 `mail_failed`（HTTP 200），UI 可以重发。HTTP 测试通过 Loader 注入假的 Mailer 子类；它们从不打开真实 SMTP。

### hosted 与 web

父规范的 Out of Scope 允许本地 `dsh web` 不含 Account。托管组合包是第三个 profile 模板，因此单 home 的 web 不会被悄悄变成 SaaS。托管加载必需环境变量：`DSH_POSTGRES_URL`、`DSH_PUBLIC_BASE_URL`、`DSH_SMTP_HOST`、`DSH_SMTP_FROM`。可选的 `DSH_OPERATOR_EMAILS` 是逗号分隔的 Operator 列表。

### 测试

真相来源是 Loader 组合的 HTTP：对 `127.0.0.1:port` 做真实 `fetch`、cookie jar、假邮件发送，以及假的 `Date.now` 时钟。测试断言状态码、JSON、cookie 效果，以及假实现是否被调用 — 不断言 PostgreSQL 行或哈希算法。

## 曾考虑的替代方案

**把 Account 折进 `packages/identity` 或 `packages/credentials`。** 否决：identity 明确不是经过身份验证的账户，credentials 是模型提供方密钥。混在一起会冲突词汇和存储。

**在 `/api` 上增加 `session.register` / Typert `accounts/signIn`。** 被父规范否决：未认证鉴权路由是 `/api` 旁边的新 HTTP 端点。`/api` 仍是现有 Host RPC；工单 #4 再把它绑定到 Sign-in session。

**让鉴权 UI 路径走 `frontend-static` 的 SPA rewrite。** 否决：dist 服务器对未知路径返回 404。邮箱链接需要具名 `/verify` 路由。

**让每个 `web` profile 都要求 Account。** 否决：父规范把本地 `dsh web` 留作独立 profile。托管组合包加上 `PROFILE_TEMPLATES.hosted` 是更小的产品改动。

**用 SQLite 存 Account 行。** 被 ADR 0017 否决。

**进程内 user-service 测试 seam。** 被父规范 Testing Decisions 否决。带假邮件发送的 HTTP 是唯一 seam。

**用 JWT 作为 Sign-in session。** 否决：产品词汇禁止把 JWT 当作产品名称，而且规范要求服务端 session id，以便密码重置能结束该 Account 的每一个 Sign-in session。

## 后果

七个新包和一个托管 profile 增加了 Loader 行、环境配置，以及托管表面上的 cookie。本地 `dsh web` 仍然没有 Account。`/api` Session 方法绑定已登录 Account。Ban 与注册冻结落在这条 seam 上；Deletion 和 Operator Session 访问仍属后续工单。使用 PGlite、假邮件发送和假时钟的 HTTP 测试钉住注册／验证／登录／退出／重置／滑动／Ban／冻结，不需要真实 SMTP 或共享 Postgres。
