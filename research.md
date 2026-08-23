# DeepSeek Harness 学习与发现报告

调研日期基于当前工作区源码与文档（本 fork 已同步到上游 `0.1.1-rc.2`）。本文件记录**现有系统如何工作**，以及它对「公开 SaaS + 登录注册 + 按账号隔离」的含义。产品决策见 `CONTEXT.md` 与 `docs/adr/`；本文不是规格书。

## 1. 产品是什么

DeepSeek Harness（`dsh`）是 DeepSeek 的开源 agent 框架。口号是 **everything is a plugin**：没有一块「核心」供你打补丁，所有能力都是 Cordis 插件，装上就贡献服务、事件和可撤销的副作用，卸下就收回。

一次运行的 `dsh` 是按 **profile** 叠出来的插件树：

1. 空树
2. profile 列出的 **bundle**（`dsh-base`，再加 `dsh-web-app` 或 `dsh-headless`）
3. `$DSH_HOME/profiles/<name>/cordis.patch.yml`
4. `$DSH_HOME/cordis.patch.yml`
5. `--patch` 覆盖

`dsh web` 是 `--profile web` 的别名。查看实际树：`dsh --profile web --dump-config`。

源码入口：

- 架构：`docs/architecture.md`
- 本机 Web 指南：`docs/user/guide/index.md`
- 从源码启动：`pnpm install && pnpm run build && pnpm dsh web`

## 2. 运行时形态：单进程、单 home、本机操作者

默认 `dsh web` 监听 **`http://127.0.0.1:3080`**（字面量 `127.0.0.1`，不是 `localhost`）。HTTP 载体是 `packages/host/webserver`：一个 `node:http` 插件，不管 agent 概念，只做路由注册。浏览器 SPA（`apps/web` → `dsh-client-web`）通过同源 `POST /api/<method>` 和两条下行 WebSocket（`/api/events.mux`、`/api/events.host`）跟 Host 说话。

**所有用户数据落在一个 Harness home**（`packages/util/home-paths`）：

| 路径 | 内容 |
|------|------|
| `$DSH_HOME` 或 `~/.dsh` | 根 |
| `.anonymous-user-id` | 匿名相关 id |
| `settings.yaml` | 设置 |
| `.credentials.yaml` | 模型凭据 |
| `.env` | 用户级环境变量 |
| `sessions/` | Agent Session 的 JSONL 日志 |
| `storages/workspace.json` | Workspace 登记 |
| `attachments/v1/` | 附件 |
| `.agent-presets/` | 用户写的 preset |
| `profiles/web/cordis.patch.yml` | 该 profile 的本地补丁 |

没有「这个人的目录」。能连上这个进程的客户端，看见的是**同一份** home。

## 3. 「Identity」不是登录

`packages/identity/` 只有 `anonymous-user-id`。官方 README 写明：这些值 **do not represent an authenticated account**。

`getOrCreateAnonymousUserId()` 在 home 里放一颗 UUID v4。作用域是 **harness home**，不是机器、不是浏览器用户。用途只有：

- OpenTelemetry `user.id`
- `/feedback` 确认文案
- 调 DeepSeek 时的请求头 `x-deepseek-harness-user-id`

`SessionHeader` 没有 owner。会话事件里的 `source: { kind: 'user' }` 表示「人类消息 vs 模型」，不是账号。

本 fork 的词汇约定（见 `CONTEXT.md`）：登录后的人叫 **Account**；这颗 UUID 叫 **Anonymous identity**，禁止再叫 User id。

## 4. Credentials 也不是登录密码

`ctx.credentials` 管的是 **模型提供方密钥**：

- `CredentialRef`：环境变量名背后是什么（如 `DEEPSEEK_API_KEY`）
- `CredentialKey`：某插件为某 id 存的 record（`api-key` 或 OAuth `grant`）

本地解析顺序（高优先赢）：启动 env → `$DSH_HOME/.credentials.yaml` → `<cwd>/.env` → `$DSH_HOME/.env`。文件模式 `0600`，挡的是**其他 OS 用户**，不是同一个 UID 上的第二个浏览器。

`ctx.authorization` 是插件向坐在电脑前的人要提供方凭据（设备码、粘贴 key），不是 Account 登录。ACP 表面 `authMethods: []`，`authenticate` 是 no-op。

Web 只暴露凭据的「引用半边」。配置面（settings / credentials / 本机选目录）被钉在 **loopback same-origin**，注释写明：`trustedHosts` **explicitly not authentication**，直到有真正的认证层。

## 5. Session 与 Workspace

**Session**（`packages/core/session`）是内存里一份只追加的 `SessionEvent` 日志，是一次 agent 交互的权威历史。LLM 消息由日志派生。Web 默认持久化到 `$DSH_HOME/sessions`（JSONL，可 zstd）。Header 有 `id`、`createdAt`、可选 `cwd`、parent、preset 等，**没有 Account**。

**Workspace**（`packages/workspace/workspace`）是宿主侧登记：稳定 id、规范路径、标题、该目录下的 session 列表。对模型不可见。一个进程可以挂多个 workspace，但 registry 只有一份，存在 `$DSH_HOME/storages/workspace.json`。工具真正读写的是 session 的 `cwd`，并以 **Host 进程的 OS 用户** 执行 bash/fs。

创建会话：`session.create({ workspaceId })` 用该 workspace 路径当 cwd。

## 6. Web 信任模型：可达性，不是认证

`docs/subsystems/web-server.md`：`host` 只允许 `127.0.0.1`（默认）和 `0.0.0.0`。**没有 TLS、没有认证、没有 Origin 策略。** 非 loopback bind 等于把整台服务器暴露给该网络。

CLI **故意拒绝** `dsh web --host 0.0.0.0`（「会把远程代码执行暴露到网络」）。官方认可的远程用法是：进程仍绑 `127.0.0.1`，用 SSH 端口转发。反向代理 / 生产加固被标为 **不在 v1 范围**。

`/api` 的 Host 检查是 **DNS-rebinding 围栏**，不是登录。过围栏的调用者就是操作者。`session.create` 之后 agent 可以按策略跑 bash，因此远程暴露 ≈ 远程代码执行。

多个浏览器标签**可以**同时连同一进程：共享全部 session、workspace、审批队列、jobs。谁先 `respond` 谁成交。没有「一会话一写入者」的客户端锁。

## 7. 一次请求在系统里怎么走

简化的 Web 路径：

```
浏览器 SPA
  → dsh-host-webserver（路由）
  → dsh-client-connection（信任围栏 + HTTP/WS）
  → Typert RPC 网关 或 API Proxy
  → Cordis 树上的 session / agent-loop / tools / llm
```

一次对话回合（turn）：

1. `turn/start`
2. 取队列里的用户消息
3. 拼 system prompt 与 tool schema
4. `agent/pre-step` → 进入 step
5. `llm/stream` → `assistant/chunk*` → `assistant/message`
6. 若有 tool：`tool/call` → 执行 → `tool/result`
7. 需要再请求模型则下一 step，否则 `turn/end`

扩展点是事件，不是继承。改行为的正确方式通常是再挂一个插件。

## 8. 和 CLI / SDK 的关系

| 表面 | 入口 | 是否这套 HTTP GUI |
|------|------|-------------------|
| Web UI | `dsh web` | 是 |
| Headless | `dsh --profile headless "task"` | 否 |
| TypeScript / Python SDK | stdio JSON-RPC 拉起 runtime | 否 |
| ACP | Agent Client Protocol | 否 |

Python SDK 是 Web UI 的编程替代，不是浏览器客户端。`DEEPSEEK_BASE_URL` 指向**模型**，与 3080 无关。

## 9. 对「公开 SaaS + 登录 + 按账号隔离」的硬约束

已接受决策见 `docs/adr/0001-public-saas-account-isolation.md`。下面是代码里**现在就会立刻破掉**的假设，不是设计建议：

1. **一个 home = 一份匿名 id、一份 settings、一份凭据、一份 workspace 账本、一份 session 树。** 多人共享即共享密钥和全部对话。
2. **`SessionHeader` 无 owner。** `session.list` / 搜索的「授权集」是本机全部 session。
3. **Web 无 Account。** 过 Host 围栏即可 prompt、读历史、在 loopback 上改密钥。
4. **工具以 Host 的 OS uid 跑。** 云上若仍用「用户选本机文件夹」，语义不成立；若改成服务器上的目录，则每个 Account 必须有沙箱，否则租户之间文件系统打通。
5. **`0.0.0.0` 被 CLI 挡住**，直到有认证层。公开互联网暴露还需要 TLS、会话 cookie/token、以及把 settings/credentials 从「loopback 特权」改成「已登录 Account 特权」。
6. **网关诊断按单用户编写。** 搜失败会带内部细节，注释要求多用户载体必须改成对外安全的诊断。
7. **OTel / DeepSeek / feedback 把所有流量算成同一个 anonymous id。** SaaS 上应改成 Account，并避免把 Account id 泄漏进模型可见内容（现有 DeepSeek 适配器把 harness user id 放在 header，不进 prompt，这条约束应保留）。

## 10. 源码地图（按主题）

| 主题 | 位置 |
|------|------|
| 插件树 / profile | `docs/architecture.md`，`packages/boot/app-boot`，`packages/bundle/*` |
| HTTP | `packages/host/webserver`，`docs/subsystems/web-server.md` |
| `/api` 信任 | `packages/client/connection` |
| RPC | `packages/api/gateway`，`packages/host/apiproxy` |
| Session | `packages/core/session`，`packages/session/session-persistence-jsonl` |
| Workspace | `packages/workspace/workspace` |
| 匿名 id | `packages/identity/anonymous-user-id` |
| 模型凭据 | `packages/credentials/*`，`docs/subsystems/credentials.md` |
| 设置 | `packages/settings/*` |
| Agent 循环 | `packages/core/agent-loop`，`docs/subsystems/core.md` |
| CLI | `apps/cli` |
| 前端壳 | `apps/web`，`packages/client/web` |

## 11. 调研尚未回答的产品问题

这些不能从代码推出，留在 grilling 后续轮次：

- Workspace 在 SaaS 上住在哪（服务器沙箱 vs 仍在用户机器）
- 模型 Credential 是用户自带还是平台代付
- 注册是否要邮箱验证 / 邀请码
- 谁是 Operator
