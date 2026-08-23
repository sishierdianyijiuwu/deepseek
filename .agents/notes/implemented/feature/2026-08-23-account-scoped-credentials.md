# Agent Note: Account-scoped Credentials and prompt gate

Status: implemented

English | [中文](2026-08-23-account-scoped-credentials.zh.md)

## Problem

Hosted Credentials lived in one process-wide `$DSH_HOME/.credentials.yaml` (and the launching environment). Two Sign-in sessions would read and write the same secret. Loopback same-origin was the authorization for `credentials.*` writes. An Account with no Credential could still send Session messages, which would then fail inside the LLM adapter — or succeed on another Account's key.

## Decision

The hosted bundle replaces the `credentials` row with `dsh-credentials-account`. Each signed-in Account has `$DSH_HOME/credentials/<accountId>.json`. The process environment is not a layer. `resolve` is per call, so a Models-page write reaches the next request without a restart. Writes require `currentAccountId()` from the Sign-in session.

When `ctx.accounts` is composed, `credentials.describe` / `set` / `unset` are not loopback-pinned; the Sign-in session that `/api` already requires is the authorization. Local `dsh web` without Accounts keeps the loopback pin.

Hosted `session.prompt` refuses with `credential-missing` after Session visibility, when `hasStoredSecret()` is false. Sign-in, `/auth/me`, and `session.list` / `session.create` still work.

## Alternatives considered

**Keep credentials-local and prefix keys by Account.** Rejected because the inherited environment would still win and share a platform key across Accounts (ADR 0003).

**PostgreSQL rows for Credentials.** Rejected because ADR 0017 does not put secrets in PostgreSQL; the existing Credential document model stays files, keyed by Account.

**Refuse inside the LLM adapter only.** Rejected because a Session message would already be accepted; the product rule is that sending is refused.

## Consequences

HTTP tests with two cookie jars are the source of truth. Workspaces, Ban, and Operator access remain later tickets. Local `dsh web` still uses `dsh-credentials-local`.

## Required verification

HTTP: two jars isolate `credentials.describe` / `set`; a jar with no Credential can sign in, list, and create a Session, and `session.prompt` is `credential-missing` until that jar saves a Credential, after which the same prompt is not `credential-missing`. Connection: with Accounts composed, `credentials.*` on a trusted host is 401 without a cookie and not 403 with one; `settings.describe` stays 403.
