# DeepSeek Harness (hosted)

A hosted product built from DeepSeek Harness in which each person has an Account, signs in, and only sees their own work. The control plane is self-hosted; tool execution runs in an E2B execution world.

## Language

**Account**:
A person identified by an email address, who registered with a password. The Account cannot use the product until that email is verified.
_Avoid_: User, client, customer, tenant, anonymous user

**Unverified Account**:
An Account whose email has not yet been verified. It cannot sign in to Sessions or Workspaces.
_Avoid_: Incomplete user, pending user

**Operator**:
An Account whose email is on the host's operator email list. Operators are not a separate kind of login.
_Avoid_: Admin, superuser, first user, root

**Anonymous identity**:
A random UUID scoped to one harness home, used only for telemetry and provider-request correlation. It is not an Account.
_Avoid_: User id, account id

**Password**:
The secret that proves control of an Account at sign-in.
_Avoid_: Credential, API key, token

**Credential**:
A model-provider secret (API key or OAuth grant) used to call an LLM. It is not a Password.
_Avoid_: Password, login token, account secret

**Sign-in session**:
The period after a successful sign-in during which the browser is treated as that Account. It lasts 14 days and slides forward on use. A password reset ends every Sign-in session for that Account.
_Avoid_: Session (unqualified), JWT, cookie

**Session**:
The append-only interaction log of one agent run. A Session is owned by one Account.
_Avoid_: Chat, conversation, sign-in session

**Executing Session**:
The at most one Session for an Account that is currently running tools in an execution world. Other Sessions of that Account may be read, not executed, until it stops. When that Account's daily execution-world time is exhausted, no new Executing Session can start; reading history and changing Credentials still work.
_Avoid_: Active chat, live tab

**Ban**:
An Operator action that stops an Account from signing in without erasing its Sessions, Workspaces, or Credentials.
_Avoid_: Delete, suspend (as a second word for the same thing)

**Deletion**:
The Account's own erasure of itself: Account, Sessions, Workspaces, Credentials, and a live Executing Session. It is not a Ban.
_Avoid_: Ban, deactivation

**Control plane**:
The self-hosted process that serves the Web UI, Accounts, Sign-in sessions, Session logs, and the durable copy of each Workspace.
_Avoid_: Server, backend, host (unqualified; Host already names the GUI process in this codebase)

**Workspace**:
A project directory owned by one Account. The durable copy lives on the control plane (at most three Workspaces per Account, 1 GiB each). For a Session it is copied into that Account's execution world and copied back afterwards. It may start empty or as a public-git Import. It is not a folder on that person's laptop.
_Avoid_: Repo, project, cwd, local folder

**Import**:
Creating a Workspace by cloning a public git repository. Private repositories are out of v1.
_Avoid_: Upload, sync, attach folder, private clone

**Execution world**:
An E2B sandbox where one Account's tools run, including bash and filesystem effects. It is not the control-plane machine.
_Avoid_: Sandbox (that word already names the local file-effect seam in this codebase), jail, Docker

**Operator access**:
Read-only viewing of another Account's Sessions and Workspace files by an Operator, for support or audit. The Operator cannot prompt or run tools as that Account. Every such opening is written to the audit log.
_Avoid_: Shared workspace, impersonation, break-glass write

**Audit log**:
The durable record of Operator access: which Operator, which Account or Session, when.
_Avoid_: Activity feed, admin history
