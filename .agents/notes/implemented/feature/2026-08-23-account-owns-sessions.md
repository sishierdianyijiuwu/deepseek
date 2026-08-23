# Agent Note: Account-owned Sessions

Status: implemented

English | [中文](2026-08-23-account-owns-sessions.zh.md)

## Problem

Host `/api` treated reachability as operator identity. After Accounts exist, two Sign-in sessions sharing one process would still see one global Session list, prompt each other's logs, and subscribe to the same mux. A missing owner field must not mean "visible to everyone". Anonymous identity is not an Account id.

## Decision

When `ctx.accounts` is composed, `dsh-client-connection` requires a live `dsh_sign_in` cookie on every `/api` HTTP request and WebSocket upgrade. Missing or dead cookies answer 401; `/auth` and static routes stay callable. `runWithAccount` binds the Account for that request.

`SessionHeader.owner` stores the Account id on JSONL header metadata and SQLite `sessions.owner` (schema 18). `session.create` stamps the signed-in Account; fork and subagent `childSessionMeta` copy it. `session.list`, search, history, prompt, cancel, updateQueue, export, fork, mux, and host session frames include only Sessions whose owner equals that Account. Opening another Account's id, or a Session with no owner, fails as not found, including before export flush/`readRaw`. Search binds visible ids as `sessionFilters` when Accounts are composed. Local compositions without `ctx.accounts` do not stamp or filter owner.

## Alternatives considered

**PostgreSQL table of Session ids.** Rejected because Session event logs stay JSONL files; owner belongs on the existing header.

**Filter only `session.list`.** Rejected because prompt, history, export, and mux would still leak.

**401 vs `session-not-found` for a guessed id.** Unauthenticated callers are 401. A signed-in caller who presents another Account's id gets the same not-found as an unknown id, so ids cannot be probed.

## Consequences

Hosted HTTP tests with two cookie jars are the source of truth. Password reset, Credentials, Workspaces, and Operator access remain later tickets. SQLite databases stamped schema 17 no longer open.

## Required verification

HTTP: unauthenticated `/api` is 401, including a dead cookie and an unauthenticated mux upgrade; `/auth/me` and a missing static path work without a cookie; two jars isolate `session.create`/`list`/`history`/`prompt`/`cancel`/`updateQueue`/`fork`/`search`/`export`; the owning jar's mux receives the new Session id and the other jar's mux does not; a Session with no owner is absent from `list`.
