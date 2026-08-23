# Agent Note: Public git Workspace Import

Status: implemented

English | [中文](2026-08-23-public-git-workspace-import.zh.md)

## Problem

A hosted Account can already create an empty Workspace, but a real project often starts as a public git remote. Cloning that remote must land in a new slot the Account owns, count toward the three-Workspace cap, and refuse private or credential-bearing remotes so v1 never collects extra secrets. Import also must not write another Account's durable tree, and a 1 GiB clone must not keep the slot.

## Decision

`CloudWorkspaces.importPublicGit` clones a public HTTPS git URL into an unlisted directory under `{root}/{accountId}/` and registers the Workspace only after clone and the 1 GiB check succeed. The URL parser accepts only `https:` with no userinfo; `http`, `ssh`, `git`, `file`, `git@host:path`, and `https://user:token@host/…` throw `CloudWorkspaceImportUrlError` before `git` runs. Error text and RPC `gitUrl` details are redacted (no userinfo, no exec stderr). Clone runs with credential helpers off, file/ssh/git/ext protocols denied, `core.symlinks=false`, `http.followRedirects=false`, an isolated `HOME`, and `GIT_TERMINAL_PROMPT=0`. The unary AbortSignal, `importTimeoutMs` (default 300s), and dest-size polling abort a hung or oversized clone; `importTlsInsecure` (default false) is the test-only TLS skip for a self-signed local `git-http-backend`. A private remote (HTTP 401), cancel, timeout, or other clone failure throws `CloudWorkspaceImportError` and removes the staging directory. `writeFile` refuses symlink paths (`O_NOFOLLOW`).

The Host method is `workspace.import({ gitUrl, title? })` and forwards the carrier AbortSignal. Missing cloud Workspaces or a local Host return `workspace-import-refused`. A fourth slot is `workspace-limit`. A tree past 1 GiB is `workspace-quota-exceeded`. Import always creates under `{root}/{accountId}/…`; there is no target path into another Account's tree. HTTP tests clone a local public git fixture, not the public internet.

## Alternatives considered

**`gitUrl` on `workspace.create`.** Rejected: empty create and Import fail for different reasons (path vs remote). A dedicated method keeps `workspace.create` empty-only on cloud and matches the product verb Import.

**Allow `http://` for fixtures.** Rejected: the product contract is HTTPS. Tests serve git-http-backend over loopback HTTPS with a self-signed cert.

**Keep a failed or oversized clone as an empty Workspace.** Rejected: that would consume a slot the Account cannot use for a real Import. Clone runs unlisted; failure and quota remove the staging directory without a registry row.

**Register first, then clone.** Rejected: the Account could list, write, or attach a Session to a partial tree, and a hung remote would occupy a cap slot.

## Consequences

Hosted `/api` can Import without a directory picker or extra credentials. Private git, deploy keys, and GitHub App remain out of v1. E2B hydrate still must reuse the same 1 GiB cap.
