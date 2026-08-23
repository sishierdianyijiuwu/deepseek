# Spec: hosted Accounts, isolation, and E2B execution

## Testing seam

**One seam: the control-plane HTTP surface.**

Acceptance tests drive the product only through HTTP: unauthenticated auth routes (register, verify email, sign in, password reset) and the existing Host `/api` RPC (and its event WebSockets), now bound to a Sign-in session. Mail delivery and the E2B SDK are fakes *behind* this seam, not extra seams.

Do not add a second in-process seam for “user service” or “workspace service” unless HTTP cannot observe the behavior. Clock and daily-cap boundaries are injected behind the same HTTP tests.

## Problem Statement

DeepSeek Harness today is a single-home local tool. Whoever can reach `dsh web` sees every Session, Workspace, setting, and Credential, and tools run as the OS user. There is no Account, no sign-in, and the process is not safe to put on the public internet.

I want this fork to be a public product: people register with email and password, each Account only sees its own work, the agent still edits real project files and can run bash, and I can deploy the Web UI on my server for many people.

## Solution

Ship a self-hosted **control plane** (HTTPS reverse proxy in front, dsh still on loopback) where anyone can create an **Account**, verify email, and sign in. Each Account is isolated. Model **Credentials** are bring-your-own. **Workspaces** live as durable directories on the control plane (at most three, 1 GiB each), empty or imported from a public git URL. Tools run in an **E2B execution world** paid by the host, with one **Executing Session** at a time and 60 minutes per UTC day. **Operators** (configured emails) may read other Accounts’ Sessions and files; they cannot prompt or run tools; every opening is audited. **Ban** keeps data; **Deletion** erases it.

## User Stories

1. As a visitor, I want to register with email and password, so that I can get an Account on the public product.
2. As a visitor, I want registration to reject an email that already has an Account, so that nobody silently takes over my address.
3. As a visitor, I want a verification email after registering, so that only I can activate that address.
4. As an Unverified Account, I want to be unable to sign in to Sessions or Workspaces, so that unverified inboxes cannot use the product.
5. As an Unverified Account, I want to complete email verification via a link, so that my Account becomes usable.
6. As an Unverified Account, I want an expired or reused verification link to fail clearly, so that I can request a new one instead of appearing signed in.
7. As an Account, I want to sign in with email and password, so that the browser is treated as me.
8. As an Account, I want a failed sign-in with a wrong password to tell me it failed without revealing whether the email exists, so that Accounts cannot be enumerated cheaply.
9. As an Account, I want my Sign-in session to last 14 days and slide forward when I use the product, so that I am not logged out every morning.
10. As an Account, I want closing the browser not to end the Sign-in session, so that I can come back later still signed in.
11. As an Account, I want to sign out, so that this browser is no longer treated as me.
12. As an Account, I want to reset my password using the verified email, so that I can recover the Account.
13. As an Account, I want a password reset to end every Sign-in session I have, so that a stolen browser cookie dies with the old password.
14. As an Account, I want a reset link to be single-use and time-limited, so that forwarded mail cannot reset me forever.
15. As a visitor, I want unauthenticated `/api` Session, Workspace, Credential, and Operator calls to be rejected, so that the old “whoever can reach the port is the operator” model is gone.
16. As an Account, I want `session.list` and related reads to return only my Sessions, so that I never see another person’s work.
17. As an Account, I want creating a Session to attach it to my Account, so that it cannot appear in someone else’s list.
18. As an Account, I want opening a Session by id that I do not own to fail as not found (not forbidden with a leak), so that ids cannot be probed across Accounts.
19. As an Account, I want Workspace list, create, and Import to cover only my Workspaces, so that project directories are private.
20. As an Account, I want to create an empty Workspace, so that I can start a project without a git remote.
21. As an Account, I want to Import a Workspace from a public git HTTPS URL, so that the agent can work on a real repo.
22. As an Account, I want Import of a private git URL to fail, so that v1 does not collect extra secrets.
23. As an Account, I want at most three Workspaces, so that disk on the control plane stays bounded.
24. As an Account, I want each Workspace capped at 1 GiB, so that one Import cannot fill the host.
25. As an Account, I want to delete a Workspace I own, so that I can free a slot under the cap.
26. As an Account, I want the durable Workspace files to live on the control plane, so that they survive E2B sandbox timeout.
27. As an Account, I want an Executing Session to copy my Workspace into E2B before tools run, so that bash and filesystem see my files.
28. As an Account, I want Workspace changes in the execution world copied back to the control plane when the Executing Session stops (and after each turn), so that I do not lose work.
29. As an Account, I want full harness tools (bash, filesystem, network) inside that execution world, so that the product still behaves like DeepSeek Harness.
30. As an Account, I want tools not to run as the control-plane OS user, so that another Account cannot touch the host disk or my files via the process uid.
31. As an Account, I want at most one Executing Session at a time, so that two writers cannot race the durable Workspace and so E2B cost stays predictable.
32. As an Account, I want starting a second Executing Session to be refused until the first stops, so that the limit is visible rather than silent corruption.
33. As an Account, I want multiple browser tabs to view the same Executing Session, so that I can keep the UI open in two windows like the local product.
34. As an Account, I want historical Sessions to remain readable while one Executing Session is running, so that I can look at old logs without stopping work.
35. As an Account, I want to paste my own model Credential, so that the host does not pay for my tokens.
36. As an Account, I want my Credential invisible to every other ordinary Account, so that my API key is not shared through the old home file.
37. As an Account with no Credential, I want to sign in and manage Workspaces but not send Session messages, so that registration stays email+password only.
38. As an Account, I want the host to supply E2B without asking me for an E2B key, so that I do not need a second vendor account to run tools.
39. As an Account, I want 60 minutes of execution-world time per UTC day, so that open registration cannot unbounded-bill the host.
40. As an Account who has used those 60 minutes, I want to keep reading history and changing Credentials, so that a cap is not an outage of the whole product.
41. As an Account who has used those 60 minutes, I want a new Executing Session to be refused, so that tools cannot keep spending E2B.
42. As an Account, I want Anonymous identity not to be used as my Account id, so that telemetry correlation is not confused with sign-in.
43. As an Account, I want to Ban to not apply to me when I am not an Operator, so that isolation is not a self-lock.
44. As an Account, I want to delete my Account (Deletion), so that I can leave the product.
45. As an Account, I want Deletion to erase my Sessions, Workspaces, Credentials, and Sign-in sessions, so that leaving is real erasure.
46. As an Operator, I want to sign in with the same email+password flow, so that Operator is not a second login product.
47. As an Operator, I want to Ban an Account, so that I can stop a abuser without destroying evidence.
48. As an Operator, I want a Banned Account to fail sign-in, so that Ban is effective.
49. As an Operator, I want Banned Account data to remain, so that I can still perform Operator access.
50. As an Operator, I want to lift a Ban, so that a mistaken Ban is reversible.
51. As an Operator, I want to disable new registration, so that I can freeze sign-up without taking the site down.
52. As an Operator, I want to re-enable registration, so that the freeze is not permanent.
53. As an Operator, I want read-only Operator access to another Account’s Sessions and Workspace files, so that I can support or audit.
54. As an Operator, I want prompt and tool execution under Operator access to be refused, so that I cannot run bash in someone else’s execution world.
55. As an Operator, I want every Operator access written to the audit log (who, when, which Account or Session), so that a leak can be reconstructed.
56. As an Operator, I want to list Accounts by email (existence and verified/Banned state) without conversation bodies, so that I can find someone before opening a Session.
57. As an ordinary Account, I want Operator-only routes to fail as not found or forbidden, so that I cannot enumerate other Accounts.
58. As an ordinary Account, I want not to appear in another Account’s Workspace or Session list even if I guess ids, so that isolation holds.
59. As the person running the control plane, I want Operator emails to come from environment configuration, so that the first public registrant cannot seize Operator.
60. As the person running the control plane, I want a single platform E2B API key, so that I pay for execution infrastructure.
61. As the person running the control plane, I want dsh to keep binding loopback, so that the old unauthenticated RCE path is not opened on `0.0.0.0`.
62. As the person running the control plane, I want HTTPS to terminate at a reverse proxy, so that certificates stay out of the dsh process.
63. As the person running the control plane, I want Accounts, Sign-in sessions, Bans, audit log, and Workspace metadata in PostgreSQL, so that the public product has a real database from day one.
64. As the person running the control plane, I want Session event logs to stay per-Account JSONL, so that we do not stuff append-only agent logs into SQL.
65. As the person running the control plane, I want durable Workspace bytes on the control-plane filesystem (not database blobs), so that 1 GiB trees stay ordinary files.
66. As a visitor, I want the Web UI to offer register and sign-in, so that I do not need the CLI to get an Account.
67. As an Account, I want the Web UI Settings → Models to save *my* Credential, so that BYOK is visible in the same place as the local product.
68. As an Account, I want Choose workspace to list *my* cloud Workspaces (not a native OS folder picker), so that the local-directory model is gone for this deployment.
69. As an Account, I want creating a Session to require a Workspace I own, so that the agent always has a project directory in my execution world.
70. As an Account, I want Import to clone only into a new Workspace slot I own, so that clone cannot write another Account’s durable copy.
71. As an Account, I want exceeding 1 GiB during an Executing Session copy-back to fail the copy-back visibly and not grow the durable copy past the cap, so that the cap is real.
72. As an Account, I want E2B sandbox expiry not to delete my durable Workspace, so that the upstream five-minute sandbox lifetime is not my file lifetime.
73. As an Account, I want execution-world time counted against the 60-minute daily cap when a sandbox is actually running, so that sitting on the history view does not burn quota.
74. As an Unverified Account, I want to request a new verification email, so that I can recover from a lost message.
75. As a Banned Account, I want password reset not to restore sign-in, so that Ban cannot be bypassed via email.
76. As an Operator, I want Deletion of my own Operator Account to be possible but not to remove other people’s data, so that Operator is still just an Account.
77. As an Account, I want two people registering the same email concurrently to yield one Account, so that races do not create duplicates.
78. As an Account, I want changing my Credential not to require restarting the control plane, so that BYOK matches today’s Settings behavior, scoped to me.
79. As an Account, I want mux/event streams to subscribe only to Sessions I own (or Operator-access Sessions I opened read-only), so that live logs do not leak across Accounts.
80. As an Operator in read-only Operator access, I want event streams for that Session not to accept prompt or respond, so that a second tab cannot escalate from view to write.

## Implementation Decisions

- Vocabulary and product rules are those in `CONTEXT.md` and ADRs 0001–0017. Do not introduce User, tenant, or admin as product names.
- Add an Account module on the control plane: register, verify email, sign in, sign out, password reset, Deletion. Passwords are stored as one-way hashes, never reversible, never as Credentials.
- Sign-in session is a server-side session id in an HTTP-only cookie (or equivalent), 14-day sliding lifetime, bound to the Account. Password reset deletes all of that Account’s Sign-in sessions.
- Unauthenticated auth routes are new HTTP endpoints beside `/api`. All existing Host `/api` methods and WebSockets require a valid Sign-in session except health/static assets.
- After sign-in, replace the loopback-as-authentication model for Session, Workspace, and Credential operations: authorization is the Account (Operator access is the only cross-Account read). DNS-rebinding Host checks remain; they are not Account authentication.
- Privileged methods that today are loopback-only (settings, credentials, directory pick) become Account-scoped. Native OS directory picking is not used on this deployment; Workspace is a cloud directory the Account owns.
- Session header (or equivalent durable metadata) gains an Account owner. `session.list`, lookup, search, export, mux subscribe, and prompt all filter by owner. Missing owner is not “visible to everyone”.
- Workspace registry is per Account in PostgreSQL; durable files are on the control-plane filesystem namespaced by Account. Caps: 3 Workspaces, 1 GiB each, enforced on create/Import and on copy-back.
- Import clones public git over HTTPS into a new Workspace; authentication-bearing remotes are rejected.
- Execution: keep the existing E2B execution-world composition (filesystem and subprocess adapters on one sandbox). Configure sandbox lifetime to the Executing Session, not the POC five-minute default as the product file lifetime. Platform `E2B_API_KEY` only; never install that key in the sandbox.
- Hydrate: before tools run, copy durable Workspace into the sandbox cwd; after each turn and when the Executing Session ends, copy back. Cap check on copy-back.
- At most one Executing Session per Account: refuse `session.prompt` / create-and-run that would start a second sandbox. Tabs may share the one executing Session.
- Daily cap: 60 minutes of sandbox-running time per Account per UTC day, stored in PostgreSQL. Exhaustion refuses a new Executing Session only.
- Credentials stay the existing Credential model, keyed by Account, not a single home YAML shared by the process. Resolve per request from the signed-in Account.
- Operator emails from environment. Operator is an Account whose email is on that list. Operator access: read-only Session log and Workspace files; no prompt, no tools, no Credential reveal of the target Account unless already visible as metadata-free existence. Each opening appends an audit log row.
- Ban sets a flag; sign-in and password reset cannot start a Sign-in session. Operator access still works. Deletion is an authenticated Account action that removes that Account’s rows, JSONL, Workspace files, Credentials, and cookies.
- Registration freeze is an Operator-controlled flag on the control plane.
- PostgreSQL holds Account, Sign-in session, Ban, registration-freeze, audit log, Workspace metadata, daily E2B usage. Session JSONL paths stay files. Do not put 1 GiB Workspace trees in the database.
- Email: a mailer port (verification and reset). Transport is configuration (SMTP or equivalent), not part of the Account vocabulary.
- Reverse proxy terminates TLS. dsh webserver host remains loopback. Binding all interfaces stays unsupported.
- Anonymous identity remains harness-home telemetry; do not use it as Account id. Prefer Account id on outbound DeepSeek headers only if it does not appear in model-visible content (same constraint as today’s header-not-body rule).
- Web UI: register/sign-in/verify/reset screens; Workspace picker lists cloud Workspaces; hide native folder picker in this profile.

## Testing Decisions

- Good tests assert external behavior on the HTTP seam: status, JSON bodies, cookie effects, which Sessions appear, whether a prompt started an Executing Session, whether mailer and E2B fakes were invoked. They do not assert PostgreSQL rows, hash algorithms, or plugin fiber graphs.
- Test through the control-plane HTTP API (and cookie jar), including WebSocket subscribe where isolation leaks would show up. Prefer extending the existing web RPC test style (real HTTP against a running host) over new in-memory service tests as the source of truth.
- Fake the mailer and E2B SDK in those tests. Fake the clock for sliding Sign-in sessions, verification expiry, and UTC day rollover of the E2B cap.
- Cover at least: register/verify/sign-in/reset; isolation between two Accounts on `session.list` and prompt; Operator read-only and audit log; Ban vs Deletion; Credential missing blocks prompt not sign-in; second Executing Session refused; cap exhaustion blocks execution only; Import public vs private; Workspace count and size caps; unauthenticated `/api` rejected.
- Prior art: web app HTTP RPC helpers in the existing web e2e tests (`session.create` / `session.list` over `/api`); API trust-fence tests on the connection/gateway layer; session persistence tests for JSONL. New tests should look like the HTTP RPC tests, with two cookie jars instead of one anonymous client.

## Out of Scope

- Organizations, shared Workspaces, or team invites.
- OAuth / third-party sign-in.
- Private git Import, deploy keys, GitHub App.
- Platform-paid model Credentials or billing for tokens.
- Per-Account E2B keys.
- Self-hosted Docker/K8s execution worlds.
- Operator impersonation (prompt/tools as another Account).
- TLS inside the dsh process or `0.0.0.0` bind.
- Putting Session event logs or Workspace file bytes into PostgreSQL.
- Electron, ACP login, Python/TS SDK Account sign-in (stdio remains a local trusted process unless a later spec says otherwise).
- Migrating upstream local-single-home mode into this hosted profile: local `dsh web` without Accounts may remain a separate profile.
- Custom E2B pause/volume features the current plugin does not have.
- Admin console UI beyond what Operator access needs (email lookup, Ban, freeze registration, read-only Session/files, audit log).

## Further Notes

- Glossary: `CONTEXT.md`. Decisions: `docs/adr/0001` through `0017`. Codebase facts: `research.md`.
- Upstream still documents the gateway as a single-user local service; search diagnostics that leak internals must stay off the public Account API.
- E2B POC deletes sandboxes on timeout; product file durability is the control-plane copy, not the sandbox.
- Next step after this spec: `/to-tickets` to split tracer-bullet tickets with blocking edges.
