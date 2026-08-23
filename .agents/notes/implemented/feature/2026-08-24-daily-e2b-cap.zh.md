# Agent Note: 每日 60 分钟 E2B 上限

Status: implemented

[English](2026-08-24-daily-e2b-cap.md) | 中文

## 问题

开放注册把执行世界时长记在同一把平台 `E2B_API_KEY` 上。若没有按 Account 的运行上限，单个 Account 可以无界消耗该密钥。上限必须在当日分钟用尽时拒绝新的 Executing Session，且不得冻结登录、历史或 Credential 变更。

## 决策

沙箱运行时长——从 Executing Session 启动时的 `beginExecutingWorld` 到沙箱真正停止时的 `endExecutingWorld`——计入每个 Account 每个 UTC 日的 `dailyCapMinutes`（托管为 `60`）。分钟数由 `dsh-e2b` Config 持有，因此部署可从 cordis.yml 修改；`0` 或非正值会在加载时失败。PostgreSQL `SCHEMA_VERSION` `5` 存储 `executing_world_open`（仍在运行的区间）和 `executing_world_daily`（每个 `YYYY-MM-DD` 的毫秒）。提供方启动时会关闭残留的未结束区间，因此重启后的控制面会把崩溃到重启这段时间记入用量。

当 `executingWorldUsedMs` 已达上限时，Host 的 `session.prompt` / `subagent.prompt` 以 `e2b-cap-exhausted`（`capMinutes`，`resetsAt` = 下一个 UTC 零点）拒绝新的 Executing Session。复用仍在运行的 Executing Session 不再检查上限。`session.history`、登录和 `credentials.set` 从不开区间。

HTTP 测试伪造 `Date.now` 以滚动 UTC 日，并替换 E2B SDK。

## 曾考虑的替代方案

**只在内存中记账直到进程退出。** 不予采纳，因为重启会重置防滥用上限。

**在 60 分钟时杀掉仍在运行的 Executing Session。** 不予采纳：规格拒绝的是*新的* Executing Session；仍在运行的沙箱会一直跑到自己停止，之后已记账的时长才会阻止下一次启动。

**让 prompt 通过但工具失败，或冻结登录和历史。** 已在 ADR 0016 中否决：工具失败看起来像故障，而该上限针对的是 E2B，不是产品的其余部分。

**只统计工具运行时长，而不是沙箱存活时长。** 不予采纳：规格统计的是沙箱运行时长。已停止 Session 的空闲历史阅读不会保持沙箱。

## 后果

若崩溃留下 `executing_world_open`，会一直记到下一次提供方启动；控制面长时间停机时可能用尽该 UTC 日。hydrate 仍由回拷拥有；本变更只计量 start/stop。托管的 `dailyCapMinutes: 60` 是产品默认值，仍可从 cordis.yml 覆盖。
