# Public SaaS with Account as the isolation boundary

This fork is a public product: anyone may register an Account with email and password. Each Account is the isolation boundary — Sessions, Workspaces, settings, and Credentials of one Account are invisible to every other **ordinary** Account. There is no organization or shared Workspace in v1. Operators are an explicit exception; see ADR-0005.

Upstream DeepSeek Harness is a single-home local tool with no authentication. Self-hosted “one server, invited people” and company IdP were rejected so that the hosted deployment can accept open sign-up. Shared workspaces were rejected so login actually changes who can see what.

**Status**: accepted
