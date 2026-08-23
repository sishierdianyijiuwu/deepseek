# Agent Note: Account 拥有 Session

Status: implemented

[English](2026-08-23-account-owns-sessions.md) | 中文

## 问题

Host `/api` 把可达性当作操作者身份。Account 出现之后，同一进程里的两个 Sign-in session 仍会看到一份全局 Session 列表、向对方的日志发 prompt，并订阅同一条 mux。缺失 owner 不得表示「对所有人可见」。匿名身份不是 Account id。

## 决策

当组合了 `ctx.accounts` 时，`dsh-client-connection` 要求每个 `/api` HTTP 请求和 WebSocket upgrade 带有有效的 `dsh_sign_in` cookie。缺失或已失效的 cookie 返回 401；`/auth` 与静态路由仍可调用。`runWithAccount` 在该请求上绑定 Account。

`SessionHeader.owner` 把 Account id 存在 JSONL header 元数据和 SQLite `sessions.owner`（schema 18）上。`session.create` 盖上当前登录 Account；fork 与 subagent 的 `childSessionMeta` 会复制它。`session.list`、搜索、history、prompt、cancel、updateQueue、export、fork、mux 以及 host 的 Session 帧只包含 owner 等于该 Account 的 Session。打开另一 Account 的 id，或打开没有 owner 的 Session，都按未找到失败，且发生在 export 的 flush／`readRaw` 之前。组合了 Accounts 时，搜索把可见 id 绑定为 `sessionFilters`。未组合 `ctx.accounts` 的本机部署不盖、不过滤 owner。

## 曾考虑的替代方案

**PostgreSQL 里一张 Session id 表。** 不予采纳，因为 Session 事件日志仍是 JSONL 文件；owner 应落在已有 header 上。

**只过滤 `session.list`。** 不予采纳，因为 prompt、history、export 和 mux 仍会泄漏。

**猜到的 id 用 401 还是 `session-not-found`。** 未认证调用者得到 401。已登录调用者出示另一 Account 的 id 时，与未知 id 一样得到未找到，因此无法跨 Account 探测 id。

## 后果

带两个 cookie jar 的托管 HTTP 测试是真相来源。Operator access 是另一项决策（[Operator 只读访问](2026-08-23-operator-readonly-audit.zh.md)）。已盖 schema 17 的 SQLite 数据库不再打开。

## 必要验证

HTTP：未认证 `/api` 为 401，包括失效 cookie 与未认证 mux upgrade；没有 cookie 时 `/auth/me` 与缺失静态路径仍可用；两个 jar 隔离 `session.create`／`list`／`history`／`prompt`／`cancel`／`updateQueue`／`fork`／`search`／`export`；拥有者 jar 的 mux 会收到新 Session id，另一 jar 的 mux 不会；没有 owner 的 Session 不出现在 `list` 中。
