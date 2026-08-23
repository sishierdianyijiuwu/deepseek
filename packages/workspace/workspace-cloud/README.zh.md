# @deepseek-ai/dsh-workspace-cloud

[English](README.md) | 中文

托管控制面的云 Workspace（`ctx.cloudWorkspaces`）：Account 在控制面文件系统上创建空目录，或把公开 HTTPS git URL Import 进新槽位，路径按 `{root}/{accountId}/{dir}/` 命名。元数据（id、Account、标题、路径、槽位）存在 PostgreSQL 中，而不是文件 blob。上限为每个 Account 三个 Workspace、每个 1 GiB 常规文件字节（ADR 0009、ADR 0017）。

配置 `url` 为 `postgres://` / `postgresql://` 连接串，或测试用的 `pglite:`。`root` 是存放这些目录树的控制面目录。`importTimeoutMs`（默认 300000）限制一次 Import 克隆的墙钟时间。`importTlsInsecure`（默认 false）跳过 TLS 校验，仅供自签名的本地 git fixture 使用；生产必须保持 false。缺少 `url` 或 `root`、连接失败、或 schema 版本不是 `SCHEMA_VERSION`（1）会在加载时失败。该插件注入 `workspaceRegistry`，因此新建目录同时也是 Host Workspace，Session 挂载路径无需另走一套。

`createEmpty` 分配槽位 0..2；第四次创建抛出 `CloudWorkspaceLimitError`。`importPublicGit` 把公开 HTTPS git 远程（仅 `https:`、无 userinfo）克隆进 Account 前缀下尚未登记的目录，关闭凭据助手、禁止检出符号链接、禁止 HTTP 重定向，并带墙钟超时与目标目录体积轮询；超过 1 GiB 会中止克隆（`CloudWorkspaceQuotaError`）。仅在克隆与体积检查成功后才写入注册表行。私有远程、其他协议、取消、超时以及克隆失败抛出 `CloudWorkspaceImportUrlError`／`CloudWorkspaceImportError`，不会保留槽位。Import 始终落在调用方 Account 的命名空间下；没有写入另一个 Account 目录树的目标路径。`writeFile` 拒绝符号链接路径，因此植入的链接不能覆盖另一个 Account 的文件。启动时按路径把每一行 PostgreSQL 记录收养进 `workspaceRegistry`，因此即使 KV 被清空，持久目录仍会出现在列表中。`writeFile` 与 `deleteOwned` 共用一条按 Workspace 串行化的链；`writeFile` 会重新检查所有权、遍历目录树，并拒绝会使总量超过 1 GiB 的写入（`CloudWorkspaceQuotaError`）。`owns` / `listOwned` / `getOwned` / `deleteOwned` / `listFiles` / `readFile` 是 Host `/api` 使用的 Account 隔离检查。另一个 Account 的 id 表现为找不到，而不是单独的禁止错误。

E2B 回拷是后续工单；它必须使用同一 1 GiB 上限（`writeFile` 或等价的树写入），而不是直接改写持久副本。在 E2B hydrate 成为摄入路径之前，Session cwd 上的本地工具写入也会绕过 `writeFile`。

## Model Experience

None, as cloud Workspace metadata and control-plane files never enter a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **没有 E2B hydrate / 回拷** — 执行世界同步是后续工单；1 GiB 上限在串行化的 `writeFile` 与 Import 克隆摄入上执行（包括克隆过程中的目标目录体积轮询）。Session cwd 上的工具写入不是这条摄入路径。
