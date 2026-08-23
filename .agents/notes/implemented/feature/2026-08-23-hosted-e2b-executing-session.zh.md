# Agent Note: Hosted E2B execution world, hydrate/copy-back, one Executing Session

Status: implemented

[English](2026-08-23-hosted-e2b-executing-session.md) | 中文

## Problem

托管控制面在同一个自托管进程上提供 Web UI、Account 和持久 Workspace 副本。工具文件系统和 bash 不能以该进程的 OS 用户身份运行：共享 uid 上的 landlock 不是多租户边界，而 E2B 沙箱是短暂的（超时即删除）。因此持久文件必须留在控制面，在 Executing Session 开始时拷进新的执行世界，再拷回来，且不得把平台 `E2B_API_KEY` 装进沙箱，不得让 Workspace 超过 1 GiB，也不得让同一 Account 的两个 Session 竞态这份副本。额外浏览器标签页仍须能查看同一个 Executing Session。

## Decision

托管 bundle 把本地 `subprocess`、`fs-sandbox`、`bash-sandbox` 换成 `dsh-e2b` + `dsh-fs-e2b` + `dsh-subprocess-e2b` + `dsh-bash-local`，并禁用 `dsh-sandbox-local`。`dsh-e2b` 的 `perExecutingSession` 在 `startExecutingSession` 时为每个 Account 的 Executing Session 创建一个沙箱，而不是在进程构造时创建。平台密钥只配置宿主 SDK 的 `Sandbox.create` 调用，绝不会作为沙箱 `envs` 传入。`getSandbox()` 通过发起 Agent 的 Account owner 路由。

`dsh-workspace-cloud` 在 Executing Session 开始时把常规文件 hydrate 进沙箱 cwd（跳过 `.dsh-e2b`），并在家族（父 Session 与仍存活的子 Session）idle 后通过同一 1 GiB 上限回拷远程目录树。超过上限时在任何持久 unlink／写入之前抛出 `CloudWorkspaceQuotaError`。合法的 ≤1 GiB 替换先清空再写入，避免残留文件触发逐文件 `treeBytes`。任何回拷失败都会追加 `workspace/copy-back-failed`。沙箱 kill／过期不删除持久目录。

Host 的 `session.prompt` / `subagent.prompt` 在 prompt 接纳之后按家族根 Session 获取该 Account 的锁。第二个家族以 `executing-session-busy` 拒绝。额外标签页可以对同一家族做 history／mux／prompt。Host 在入队 `startExecutingSession` 之前先加上 executing hold；该调用报告创建还是复用，因此替换沙箱会被 hydrate。回拷 waiter 把仍存活的沙箱视为 `executingSandbox === bind.sandbox`；若 stop 已删除槽位则丢掉 waiter，好让替换 start 安排自己的 waiter。`startExecutingSession`／`stopExecutingSession` 共用一条按 Account 串行链。托管 `api-gateway` inject `e2b`，且 `createApiProxy` 把回拷 drain 挂在 `e2b` 之下，因此 drain 先于沙箱 kill。HTTP 测试伪造 E2B SDK，并把 `e2b` 放在网关之后加载。

## Alternatives considered

**进程级单 E2B 沙箱。** 否决：多个 Account 会并发执行；单沙箱会混租户。

**同一 Session 在 idle turn 之间保持沙箱，直到显式 stop RPC。** v1 否决：没有 stop API 时，web Agent 一直 attached，锁永不释放，第二个 Session 永远无法启动。家族 idle 时回拷；仅当回拷后家族仍 idle 才 stop。每日分钟计数是后续工单。

**用逐文件 `writeFile` 回拷、不做树替换。** 否决：持久树中的旧文件会留下，而且在已经很大的树上追加新名字可能在摄入中途才触顶。`ingestWorkspaceTree` 先计量，再清空旧树并写入。

**新的 SessionEventMap 成员只带 `ignorable: true`、不生成目录。** 否决：`append` 还不能设置 `ignorable`，已知的合并类型才是默认 required-on-read。

## Consequences

托管工具效果在 E2B 中运行。本地 `dsh web` 不变。回拷串行化在 Workspace 写入链上。UTC 日 60 分钟上限未实现。HTTP 测试必须继续 mock `e2b`，不得打公共 API。
