# Agent Note: Password reset and 14-day sliding Sign-in session

Status: implemented

[English](2026-08-23-password-reset-sliding-sign-in.md) | 中文

## 问题

忘记 Password 的已验证 Account 没有恢复路径。不滑动的 Sign-in session 会在 14 个日历日后登出，即使该 Account 一直在使用产品；会话 cookie 则会在关闭浏览器时登出。若不在重置时结束该 Account 的每一个 Sign-in session，被盗 cookie 也会在改密后继续有效。Ban 尚不存在，因此重置无法查阅它。工单 #4 在另一个 worktree 绑定 `/api`；滑动不能等 Session 方法。

## 决策

密码重置与滑动有效期落在现有 Account seam 上（[包](../architecture/2026-08-23-account-mailer-postgres-seam.zh.md)）。

`requestPasswordReset(email)` 对未知、Unverified 或无效地址是静默成功，以免 HTTP 路由枚举 Account。已验证 Account 得到一次性、以 SHA-256 存储的令牌，寿命为 `passwordResetTtlMs`（默认 1 小时）；再次请求会删除前一个令牌。该发送上的 mailer 失败也是静默的。`resetPassword(token, password)` 在 Password 过短时拒绝且不消费令牌，未知或过期令牌返回 `invalid_or_expired`；成功时替换 Password 哈希、删除该 Account 的重置令牌，并删除每一个 Sign-in session 行。

`GET /reset?token=` 是具名宿主路由，因为 `frontend-static` 对未知路径返回 404。HEAD 返回 200 且不消费令牌（邮件扫描器）。GET 重定向到 `/?reset=<token>` 且不消费；overlay 再 POST `/auth/reset-password`。重置成功会清除 `dsh_sign_in` cookie。

`lookupSignIn` 用一条 `UPDATE … RETURNING` 把仍有效的 Sign-in session 滑到 `now + signInTtlMs`（默认 14 天）。`/auth/me` 随后刷新 cookie 的 `Max-Age`，使浏览器过期时间跟随服务端。关闭浏览器不会结束 Sign-in session：cookie 始终带 `Max-Age`，从不是省略 Max-Age 的会话 cookie。滑动不挂到 `/api` Session 方法上。

HTTP 测试用 spy `Date.now` 作为假时钟，并继续使用假 Mailer 子类。

## 曾考虑的替代方案

**Clock 能力 seam（`ctx.clock`）。** 否决：唯一消费者是 Account 的时间，而单一角色的 seam 是禁止的。在 Loader 组合的 HTTP 进程里 spy `Date.now`，与 Mailer 子类是同一类假实现，且不增加新的 `ctx` 键。

**只在 `/auth/me` 内滑动，让 `lookupSignIn` 保持纯读取。** 否决：每一个解析 cookie 的已认证使用都必须滑动，包括之后会调用 `lookupSignIn` 的 `/api` 查找。把滑动放在 lookup 里只写一次。

**会话 cookie（不带 `Max-Age`）。** 被 ADR 0013 否决：关闭浏览器不得结束 Sign-in session。

**在 GET `/reset` 上消费重置令牌。** 否决：邮件扫描器会 GET 邮箱链接。验证在 GET 上消费是因为它不需要额外输入；重置需要新 Password，因此只有 POST 消费。

**重置成功时创建 Sign-in session。** 否决：规范要求结束每一个 Sign-in session，使被盗 cookie 随旧 Password 一起失效；Account 再用新 Password 登录。

## 测试

带 PGlite、假邮件发送和假 `Date.now` 时钟的 Loader 组合 HTTP 钉住：已验证请求会发信；未知／Unverified／mailer 失败保持静默；有效令牌设置新 Password 且不能复用；两个 cookie jar 在重置后 `/auth/me` 都失败；空闲 13 天后 `/auth/me` 仍登录并刷新 `Max-Age`；14 天不 lookup 则过期；登录 Set-Cookie 带 `Max-Age`，因此不是会话 cookie。overlay 测试钉住忘记／重置界面和 `/?reset=` 落地。

## 后果

恢复与滑动在没有 Ban、也不把 `/api` 绑到 Sign-in session 的情况下存在。Ban 到来时必须拒绝会恢复登录的重置。schema 版本为 2；v1 控制面数据库在加载时失败。工单 #4 可以调用 `lookupSignIn` 并继承滑动。
