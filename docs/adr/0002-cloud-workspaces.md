# Workspaces live on the host

A Workspace is a directory on the server, sandboxed per Account. The agent runs on the host against that directory. Local-folder picking (upstream Web UI) and a chat-only v1 with no files were rejected: a public SaaS cannot reach a stranger's laptop disk, and stripping the filesystem would drop the harness's main value.

**Status**: accepted
