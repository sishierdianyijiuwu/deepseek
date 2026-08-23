# Agent Note: Cloud empty Workspaces with caps

Status: implemented

[English](2026-08-23-cloud-empty-workspaces-with-caps.md) | 中文

## Problem

托管 Account 不能挑选自己笔记本上的文件夹。Workspace 必须活在控制面上、归该 Account 所有，并且对数量和体积有硬上限。本地 `workspaceRegistry` 仍为 `dsh web` 收养已有操作系统目录；若把 Account 所有权、PostgreSQL 元数据和 1 GiB 目录树塞进那个 KV 注册表，会把两套产品混在一起。

## Decision

`@deepseek-ai/dsh-workspace-cloud`（`ctx.cloudWorkspaces`）是托管存储：PostgreSQL 行保存元数据（所有权、槽位、标题、路径），目录 `{root}/{accountId}/{dir}/` 保存字节。上限为每个 Account 三个 Workspace、每个 1 GiB 常规文件字节。`createEmpty` 填充槽位 0..2；第四次创建是 `CloudWorkspaceLimitError` / 线上 `workspace-limit`。`writeFile` 与 `deleteOwned` 共用一条按 Workspace 串行化的链（`writeFile` 在先前操作之后重新检查所有权、重新读取目录树，并拒绝使净增长超过 1 GiB 的写入 / `workspace-quota-exceeded`）。跨 Account 的列出、选择、挂载、写入、删除以及宿主目录浏览把该 id 或路径当作找不到／`directory-picker-unavailable`。

PostgreSQL 是槽位与所有权的真相源。启动时按路径把每一行收养进 `workspaceRegistry`，因此即使 KV 被清空仍能服务 list/create；新的注册表 id 会写回该行。标题更新同时写入两处。会话成员关系仍在注册表实体上。

组合该插件时，Host `workspace.list` 只返回该 Account 的 Workspace、`emptyCreate: true`，以及归在这些 Workspace 名下的已归档 Session id；`workspace.create` 忽略笔记本路径并创建空目录；`session.create` 要求一个归其所有的 `workspaceId`（`workspace-required`）。`host.pickDirectory`／`listDirectory`／`createDirectory` 失败。托管组合包禁用 `directory-picker`，并用 `DSH_POSTGRES_URL` 与 `DSH_WORKSPACE_ROOT` 加载该插件。Web 选择器用 `emptyCreate` 在不走原生目录流程的情况下添加 Workspace；空创建失败后重试的是空创建，而不是文件夹选择器。

公开 git Import 见 [Import Agent Note](2026-08-23-public-git-workspace-import.zh.md)。E2B 回拷不是本决策；它必须通过同一上限摄入（`writeFile` 或等价的树写入）。在 E2B hydrate 成为摄入路径之前，Session cwd 上的工具写入会绕过 `writeFile`。

## Alternatives considered

**给 `workspaceRegistry` 增加可选 Account 列。** 否决：该注册表是存储域上的路径收养、进程全局、且不是 PostgreSQL。托管元数据按 ADR 0017 属于 Postgres；把所有权双写到 KV 会留下两个真相源。

**在 Host `/api` 之外再开一条 HTTP 面。** 否决：规格的测试缝是现有 RPC。上限与隔离是带着 Sign-in cookie 的 `workspace.*` / `session.create`。

**可配置的上限尺寸。** 否决：ADR 0009 是产品不变量，不是部署可调项。HTTP 测试通过预置截断文件，再 `workspace.write` 多一个字节来观察 1 GiB。

## Consequences

托管 UI 的添加 Workspace 不再依赖目录选择器，托管 `/api` 也不能浏览控制面磁盘。未组合 `cloudWorkspaces` 时，本地 `dsh web` 不变。持久字节仍是普通文件；Postgres 从不存储目录树。Import 复用同一 1 GiB 上限（[Import Agent Note](2026-08-23-public-git-workspace-import.zh.md)）；E2B hydrate 仍将如此。
