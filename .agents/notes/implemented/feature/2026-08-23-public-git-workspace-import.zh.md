# Agent Note: Public git Workspace Import

Status: implemented

[English](2026-08-23-public-git-workspace-import.md) | 中文

## Problem

托管 Account 已经能创建空 Workspace，但真实项目常常始于一个公开 git 远程。克隆该远程必须落入该 Account 拥有的新槽位、计入三个 Workspace 上限，并拒绝私有或带凭据的远程，使 v1 不会收集额外秘密。Import 也不得写入另一个 Account 的持久目录树，且 1 GiB 的克隆不得保留槽位。

## Decision

`CloudWorkspaces.importPublicGit` 把公开 HTTPS git URL 克隆进 `{root}/{accountId}/` 下尚未登记的目录，仅在克隆与 1 GiB 检查成功后才注册 Workspace。URL 解析器只接受无 userinfo 的 `https:`；`http`、`ssh`、`git`、`file`、`git@host:path` 以及 `https://user:token@host/…` 在运行 `git` 之前抛出 `CloudWorkspaceImportUrlError`。错误文本与 RPC 的 `gitUrl` 详情经过脱敏（不含 userinfo、不含 exec stderr）。克隆关闭凭据助手、禁止 file/ssh/git/ext 协议、设置 `core.symlinks=false` 与 `http.followRedirects=false`、使用隔离的 `HOME`，并设置 `GIT_TERMINAL_PROMPT=0`。一元调用的 AbortSignal、`importTimeoutMs`（默认 300 秒）以及目标目录体积轮询会中止挂起或超大的克隆；`importTlsInsecure`（默认 false）是自签名本地 `git-http-backend` 的测试专用 TLS 跳过。私有远程（HTTP 401）、取消、超时或其他克隆失败抛出 `CloudWorkspaceImportError`，并删除暂存目录。`writeFile` 拒绝符号链接路径（`O_NOFOLLOW`）。

Host 方法是 `workspace.import({ gitUrl, title? })`，并转发载体 AbortSignal。缺少云 Workspace 或本地 Host 返回 `workspace-import-refused`。第四个槽位是 `workspace-limit`。超过 1 GiB 的目录树是 `workspace-quota-exceeded`。Import 始终创建在 `{root}/{accountId}/…` 下；没有写入另一个 Account 目录树的目标路径。HTTP 测试克隆本地公开 git fixture，而不是公网。

## Alternatives considered

**把 `gitUrl` 放在 `workspace.create` 上。** 否决：空创建与 Import 因不同原因失败（路径 vs 远程）。独立方法让云上的 `workspace.create` 保持只创建空目录，并匹配产品动词 Import。

**为 fixture 允许 `http://`。** 否决：产品约定是 HTTPS。测试通过回环 HTTPS 上的 git-http-backend 加上自签名证书来提供仓库。

**把失败或超大的克隆保留为空 Workspace。** 否决：那会占用 Account 无法用于真正 Import 的槽位。克隆在未登记目录中进行；失败与配额超限删除暂存目录，不写入注册表行。

**先注册再克隆。** 否决：Account 可能对不完整的目录树列出、写入或挂载 Session，挂起的远程还会占用上限槽位。

## Consequences

托管 `/api` 无需目录选择器或额外凭据即可 Import。私有 git、deploy key 和 GitHub App 仍不在 v1 范围内。E2B hydrate 仍须复用同一 1 GiB 上限。
