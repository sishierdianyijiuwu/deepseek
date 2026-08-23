# Agent Note: Operator Ban and registration freeze

Status: implemented

English | [中文](2026-08-23-operator-ban-and-registration-freeze.zh.md)

## Problem

A public registration page cannot treat the first Account as an Operator: that race is unsafe. The host still needs a way to stop an abuser from signing in without destroying Sessions, Workspaces, or Credentials, and a way to stop new sign-ups without taking the site down. Password reset must not undo that stop. Ordinary Accounts must not gain those actions. This slice must not open another Account's Session body.

## Decision

Operator identity is a configured email list on `dsh-account-postgres` (`operatorEmails`, hosted as `DSH_OPERATOR_EMAILS`). Emails are normalized at load; an invalid entry fails loud; an empty list means no Operators. The first registrant is not special. An Account whose normalized email is on that list is an Operator after the ordinary register / verify / sign-in flow. `lookupSignIn` reports `operator`.

Ban is `accounts.banned_at`. `ban(email)` sets it (idempotent) and deletes every Sign-in session for that Account; the Account row stays. `signIn` with the correct Password returns `banned`. `lookupSignIn` refuses a Banned Account. `liftBan(email)` clears `banned_at` (idempotent). Password reset may still replace the Password; `signIn` stays `banned` until lift.

Registration freeze is singleton `registration_control.frozen_at`. Frozen `register` returns `registration_frozen` and does not insert a row.

HTTP Operator routes live beside `/api` on the existing auth Consumer:

| Method | Path |
|---|---|
| POST | `/auth/operator/ban` |
| POST | `/auth/operator/lift-ban` |
| POST | `/auth/operator/freeze-registration` |
| GET | `/auth/operator/registration` |

They require a live Sign-in session with `operator: true`. Unauthenticated callers and ordinary Accounts receive `{ ok: false, error: { code: 'forbidden' } }` at HTTP 200. The routes do not read Session logs. Schema version is `SCHEMA_VERSION = 3`.

## Alternatives considered

**First registrant is an Operator.** Rejected by ADR 0004: a public sign-up page must not grant Operator by a race.

**Delete the Account on Ban.** Rejected by ADR 0014: Ban must keep evidence; Deletion is a later self-service action.

**A distinct Operator login or role table.** Rejected: Operator is not a separate kind of login. The env list plus the existing email+password flow is the product rule.

**Put Ban and freeze on Host `/api` RPC.** Rejected: unauthenticated-adjacent Account HTTP already owns register / sign-in beside `/api`. Operator actions that do not open Sessions stay on that Consumer.

**Refuse password reset for a Banned Account.** Rejected: the acceptance is that reset must not restore sign-in. Changing the Password while Ban holds still leaves `signIn` as `banned`.

**In-memory freeze flag.** Rejected: ADR 0017 puts registration-freeze in PostgreSQL so a restart does not re-open sign-up.

## Testing

Loader-composed HTTP with PGlite, a fake mailer, and two cookie jars pins: the first registrant is not an Operator; only `operatorEmails` can Ban, lift, freeze, and unfreeze; ordinary and unauthenticated callers get `forbidden`; Ban ends the live cookie and `signIn` returns `banned`; re-register is `email_taken`; lift restores sign-in; freeze returns `registration_frozen` then unfreeze allows register; reset after Ban still leaves `signIn` as `banned` until lift. Tests do not call `/api` or read a Session body.

## Consequences

Operators can Ban and freeze without Operator Session access (later ticket) and without Deletion. An empty `DSH_OPERATOR_EMAILS` leaves the host with no Operators. A Ban that targets the only remaining Operator email can lock that Operator out until the env list and a database edit recover it.
