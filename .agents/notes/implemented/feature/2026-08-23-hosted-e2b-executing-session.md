# Agent Note: Hosted E2B execution world, hydrate/copy-back, one Executing Session

Status: implemented

English | [中文](2026-08-23-hosted-e2b-executing-session.zh.md)

## Problem

The hosted control plane serves the Web UI, Accounts, and durable Workspace copies on one self-hosted process. Tool filesystem and bash must not run as that process's OS user: landlock on a shared uid is not a multi-tenant boundary, and E2B sandboxes are ephemeral (timeout deletes them). Durable files therefore live on the control plane and must be copied into a fresh execution world for an Executing Session, then copied back, without installing the platform `E2B_API_KEY` in the sandbox, without growing a Workspace past 1 GiB, and without letting two Sessions of one Account race that copy. Extra browser tabs must still view the same Executing Session.

## Decision

The hosted bundle replaces local `subprocess`, `fs-sandbox`, and `bash-sandbox` with `dsh-e2b` + `dsh-fs-e2b` + `dsh-subprocess-e2b` + `dsh-bash-local`, and disables `dsh-sandbox-local`. `dsh-e2b` `perExecutingSession` creates one sandbox per Account Executing Session on `startExecutingSession`, not at process construction. The platform key configures only the host SDK `Sandbox.create` call and is never passed as sandbox `envs`. `getSandbox()` routes through the initiating Agent's Account owner.

`dsh-workspace-cloud` hydrates regular files into the sandbox cwd (skipping `.dsh-e2b`) when an Executing Session starts, and copy-back ingests the remote tree through the same 1 GiB cap after the agent becomes idle (after each turn, and when the Executing Session ends). A tree past the cap throws `CloudWorkspaceQuotaError`, appends `workspace/copy-back-failed`, and leaves the durable copy unchanged. Sandbox kill/expiry does not delete the durable directory.

Host `session.prompt` / `subagent.prompt` acquire the Account lock on the family-root Session. A second family is refused with `executing-session-busy`. Extra tabs may history/mux/prompt the same family. HTTP tests fake the E2B SDK.

## Alternatives considered

**One process-wide E2B sandbox.** Rejected because many Accounts execute concurrently; a single sandbox would mix tenants.

**Keep the sandbox across idle turns of the same Session until an explicit stop RPC.** Rejected for v1: without a stop API the lock would never release while the web Agent stays attached, so a second Session could never start. Idle after copy-back is the stop. Daily minute accounting is a later ticket.

**Copy-back through per-file `writeFile` without a tree replace.** Rejected because leftover durable files would remain, and adding new names onto an already-large tree can pass the cap mid-ingest. `ingestWorkspaceTree` measures first, then replaces.

**New SessionEventMap member with `ignorable: true` only, without catalog generation.** Rejected: `append` cannot set `ignorable` yet, and a known merged type is the required-on-read default.

## Consequences

Hosted tool effects run in E2B. Local `dsh web` is unchanged. Copy-back is serialized on the Workspace write chain. The UTC-day 60-minute cap is not implemented. HTTP tests must keep mocking `e2b` so they never hit the public API.
