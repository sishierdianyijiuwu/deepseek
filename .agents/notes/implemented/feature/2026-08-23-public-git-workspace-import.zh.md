# Agent Note: Public git Workspace Import

Status: implemented

[English](2026-08-23-public-git-workspace-import.md) | 中文

## Problem

托管 Account 已经能创建空 Workspace，但真实项目常常始于一个公开 git 远程。克隆该远程必须落入该 Account 拥有的新槽位、计入三个 Workspace 上限，并拒绝私有或带凭据的远程，使 v1 不会收集额外秘密。Import 也不得写入另一个 Account 的持久目录树，且 1 GiB 的克隆不得保留槽位。

## Decision

`CloudWorkspaces.importPublicGit` 把公开 HTTPS git URL 克隆进新的自有槽位。URL 解析器只接受无 userinfo 的 `https:`；`http`、`ssh`、`git`、`file`、`git@host:path` 以及 `https://user:token@host/…` 在运行 `git` 之前抛出 `CloudWorkspaceImportUrlError`。克隆关闭凭据助手、禁止 file/ssh/git/ext 协议、使用隔离的 `HOME`，并设置 `GIT_TERMINAL_PROMPT=0`。回环 HTTPS 跳过 TLS 校验，以便 HTTP 测试使用自签名的本地 `git-http-backend`；公开远程保留 git 的默认校验。私有远程（HTTP 401）或其他克隆失败抛出 `CloudWorkspaceImportError`，并由 `deleteOwned` 释放槽位。

Host 方法是 `workspace.import({ gitUrl, title? })`。缺少云 Workspace 或本地 Host 返回 `workspace-import-refused`。第四个槽位是 `workspace-limit`。克隆后 `treeBytes` 超过 1 GiB 是 `workspace-quota-exceeded`，并释放槽位。Import 始终创建在 `{root}/{accountId}/…` 下；没有写入另一个 Account 目录树的目标路径。HTTP 测试克隆本地公开 git fixture，而不是公网。

## Alternatives considered

**把 `gitUrl` 放在 `workspace.create` 上。** 否决：空创建与 Import 因不同原因失败（路径 vs 远程）。独立方法让云上的 `workspace.create` 保持只创建空目录，并匹配产品动词 Import。

**为 fixture 允许 `http://`。** 否决：产品约定是 HTTPS。测试通过回环 HTTPS 上的 git-http-backend 加上自签名证书来提供仓库。

**把失败或超大的克隆保留为空 Workspace。** 否决：那会占用 Account 无法用于真正 Import 的槽位。克隆失败与配额超限都会 `deleteOwned`。

## Consequences

托管 `/api` 无需目录选择器或额外凭据即可 Import。私有 git、deploy key 和 GitHub App 仍不在 v1 范围内。E2B hydrate 仍须复用同一 1 GiB 上限。
