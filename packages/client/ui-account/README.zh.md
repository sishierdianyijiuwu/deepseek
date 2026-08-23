# @deepseek-ai/dsh-client-ui-account

[English](README.md) | 中文

注册、邮箱验证、登录和退出的浏览器 overlay。以 `account-gate` 占据 `shell.overlay`。在 `/auth/me` 报告 Sign-in session 之前会接管视口；之后显示带退出按钮的已登录芯片。验证链接落到具名宿主路由 `/verify`，再重定向到 `/?verified=ok` 或 `/?verified=invalid`，由该 overlay 读取。产品文案为中文。由 hosted profile 装配，不进入本地 `dsh web`。

## Model Experience

None, as the browser Account gate registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **没有密码重置界面** — 后续工单会加入重置。
- **不占据 `root`** — layout 框架保持挂载；overlay 在登录前覆盖它。
