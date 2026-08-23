# Agent Note: Daily 60-minute E2B cap

Status: implemented

English | [中文](2026-08-24-daily-e2b-cap.zh.md)

## Problem

Open registration bills execution-world time to one platform `E2B_API_KEY`. Without a per-Account runtime cap, a single Account can consume that key without bound. The cap must refuse a new Executing Session once the day's minutes are gone, and must not freeze sign-in, history, or Credential changes.

## Decision

Sandbox-running time — from `beginExecutingWorld` at Executing Session start until `endExecutingWorld` when the sandbox actually stops — counts toward `dailyCapMinutes` (hosted `60`) per Account per UTC day. `dsh-e2b` Config owns the minutes so a deployment can change them from cordis.yml; `0` or a non-positive value fails at load. PostgreSQL `SCHEMA_VERSION` `5` stores `executing_world_open` (the live interval) and `executing_world_daily` (milliseconds per `YYYY-MM-DD`). `beginExecutingWorld` returns the `started_at` token; `endExecutingWorld` deletes only that row. Host start/stop run begin/end on the per-Account E2B chain. A leftover open interval is closed at provider start so a restarted control plane charges the crash-to-restart window.

Host `session.prompt` / `subagent.prompt` refuse a new Executing Session with `e2b-cap-exhausted` (`capMinutes`, `resetsAt` = next UTC midnight) when `executingWorldUsedMs` is already at the cap. Reuse of the live Executing Session does not re-check the cap. `session.history`, sign-in, and `credentials.set` never open an interval.

HTTP tests fake `Date.now` to roll the UTC day and replace the E2B SDK.

## Alternatives considered

**Charge only in-memory until process exit.** Rejected because a restart would reset the abuse cap.

**Kill the live Executing Session at 60 minutes.** Rejected: the spec refuses a *new* Executing Session; the live sandbox keeps running until it stops, then the charged time blocks the next start.

**Let prompts through with failing tools, or freeze sign-in and history.** Rejected in ADR 0016: failing tools look like an outage, and the cap is about E2B, not the rest of the product.

**Count only tool-running time, not sandbox lifetime.** Rejected: the spec counts sandbox-running time. Idle history of a stopped Session does not keep a sandbox.

## Consequences

A crash that leaves `executing_world_open` charges until the next provider start, which can exhaust the UTC day if the control plane is down for a long time. Copy-back still owns hydrate; metering is start/stop only. Hosted `dailyCapMinutes: 60` is the product default and remains overridable from cordis.yml.
