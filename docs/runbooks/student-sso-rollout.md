# Student SSO rollout runbook (Release B)

Operator rollout for email-first institution SSO on branch
`codex/student-email-first-auth`. Nothing here has run: providers stay
disabled, no institution is approved for SSO, and no production step was
taken. Each production step needs the owner's explicit approval, a named
operator, and a recorded result before proceeding.

## 1. What ships disabled

- `GOOGLE_LOGIN_ENABLED` and `MICROSOFT_LOGIN_ENABLED` both default to
  `'false'`. While disabled, discovery returns password-only, the login
  page shows the honest no-provider note, and link-purpose reauth plus
  linking refuse (unlink, identity listing, and unlink-purpose reauth
  stay operational).
- Enabling any provider additionally requires `STUDENT_SSO_COMPLETION_URL`
  (the fixed completion route, same-site with the provider callbacks),
  per-provider client ID/secret/callback URL, and
  `STUDENT_SSO_ATTEMPT_KEY`. Boot throws when a provider is enabled
  without them; while fully disabled, stale values are ignored.
- An empty `institution_login_policies` table stays disabled: login,
  linking, and school assertions all fail closed until an administrator
  approves an institution (policy row enabled with `approved_until` and
  `approved_by`). Institution onboarding itself is unchanged — see
  `docs/runbooks/microsoft-university-onboarding.md` for the Microsoft
  enrollment consent/identity lifecycle, which SSO linking reuses but
  never mutates.

## 2. Preconditions (all NOT RUN)

1. NOT RUN — Owner approvals recorded: (a) merge of
   `codex/student-email-first-auth`, (b) production provider
   enablement per institution, (c) each institution's SSO approval
   with its domain allowlist and assertion window.
2. NOT RUN — Provider credentials issued and stored as secrets (never
   in the repo): Google client ID/secret with the exact callback URL,
   Microsoft tenant-gated client ID/secret with its callback URL.
3. NOT RUN — `STUDENT_SSO_ATTEMPT_KEY` generated (exactly 32 random bytes,
   base64url) and stored as a secret; `STUDENT_SSO_COMPLETION_URL`
   set to the fixed completion route.
4. NOT RUN — For enrollment testing, Microsoft enrollment Graph
   (`MICROSOFT_OIDC_*`) must be separately operational. Login/link/unlink
   can be tested without it. The current Microsoft-specific school assertion
   writer checks current membership evidence; linking may return
   `not_attested` without blocking account linking. Independent approved
   mailbox proof and current enrollment remain separate authorities.
5. NOT RUN — Support inbox `support@awoof.tech` confirmed monitored
   (account-recovery and mismatch-restart flows point users at it);
   `/privacy` and `/terms` publication status confirmed with the owner.
   Both are outstanding at the time of writing.

## 3. Enablement sequence (all NOT RUN)

1. NOT RUN — Apply ALL release migrations (currently through `066`,
   not just `058`) on a disposable copy first; confirm they apply
   cleanly and the consume-once triggers reject rewritten handoffs
   /grants. The release code reads and writes columns introduced
   after `058` (for example `users.active_session_issued_at` from
   `064`, benefit snapshots from `065`, claim-session tombstones from
   `066`), so stopping at an older migration breaks linked finishes
   and merchant exchanges with missing-column errors.
2. NOT RUN — Deploy the Release B build to all API instances; confirm
   every instance serves it (mixed-version window stays closed).
3. NOT RUN — With providers still disabled, prove discovery returns
   password-only and the login page shows the no-provider note.
4. NOT RUN — Install, run once, and verify alerting for the recurring
   `sso:cleanup:prod` job BEFORE enabling any provider. Without it,
   expired attempts retain encrypted verifier/observation material,
   unconsumed handoffs retain encrypted identity observations, and
   reauthentication grants accumulate instead of meeting the
   one-hour scrub and seven-day deletion contract. Record the
   schedule, the successful manual run, and the monitor here.
5. NOT RUN — Approve exactly one pilot institution (policy row
   enabled, bounded `approved_until`, named `approved_by`), then
   enable exactly one provider for the pilot.
6. NOT RUN — Canaries, each with a named test account:
   - password login still works; discovery advertises the provider
     for a pilot-domain email and password-only elsewhere;
   - provider return with no matching mailbox stays signed out
     (`link_required`, handoff in tab storage, nothing in the URL);
   - link with reauth binds the new subject, records a school assertion
     only when its evidence prerequisites hold (otherwise `not_attested`),
     and preserves the existing claim continuation;
   - unlink revokes the identity and its assertions, clears only its
     own session, and leaves enrollment consents untouched;
   - school-account assurance never authorizes benefits: an
     email-only/linked-without-enrollment account still fails every
     benefit consumer.
7. NOT RUN — Real-provider acceptance: one live Google and one live
   Microsoft return against the pilot institution (all OIDC
   discovery so far is mocked; the redirect is proven only against
   a loopback stub). No network identity calls except through the
   approved provider callbacks.

## 4. Rollback

- Setting both provider flags back to `'false'` is the safe rollback:
  outstanding attempts/handoffs restart, linked identities and their
  assertions are retained, and unlink plus password login stay
  operational. Never delete identity, assertion, or revocation rows;
  never restore a pre-enrollment build as a rollback.
- Revoking an institution approval (disabling its policy row or
  letting `approved_until` lapse) cancels outstanding flows for that
  institution only; other institutions are unaffected.

## 5. Post-rollout telemetry (outstanding)

No field INP/CWV without RUM: the lab audit
(`audit:public:candidate`, green at Release B) covers public pages
only. Real-user monitoring is operator-owned before any performance
claim about the SSO pages.

## 6. Correct local Microsoft setup (reviewed 2026-09-22)

This section supersedes chat instructions suggesting a single-tenant app,
HTTP loopback callbacks or `MICROSOFT_LOGIN_SECRET`. It is setup guidance,
not evidence that a live tenant, callback or institution is approved.

1. Inspect/reuse the existing Awoof app registration when suitable. An app
   registered in Awoof's tenant for external university users needs
   **Accounts in any organizational directory** (multitenant), not
   Awoof-directory-only. Retain exact university tenant allowlisting in
   Awoof. Do not enable personal Microsoft accounts or add education
   permissions merely to test login. University consent policies can
   still require an administrator's approval.
2. Configure trusted HTTPS for both local web and API using hostnames with
   the same registrable domain (for example, `app.awoof.test` and
   `api.awoof.test`, explicitly resolved locally). These are examples,
   not configured endpoints. The current config rejects HTTP and its
   same-site parser does not accept literal loopback hosts. Do not weaken
   Secure cookies or URL checks. Verify TLS trust, routing, exact CORS
   origin and credentials forwarding before registering callbacks.
3. Register the exact Web-platform callback ending in
   `/api/auth/student/sso/microsoft/callback`; the web completion must end
   in `/auth/student/sso/complete`. Do not overwrite the separate existing
   enrollment-verification callback. Use the actual configured HTTPS
   hostnames, not the example hostnames above unless provisioned.
4. Populate these exact keys in a gitignored backend environment through
   a secure local editor/secret mechanism, preserving existing database,
   JWT and other settings:
   `MICROSOFT_LOGIN_ENABLED`, `MICROSOFT_LOGIN_CLIENT_ID`,
   `MICROSOFT_LOGIN_CLIENT_SECRET`, `MICROSOFT_LOGIN_CALLBACK_URL`,
   `STUDENT_SSO_COMPLETION_URL`, `STUDENT_SSO_ATTEMPT_KEY`.
   The attempt key must be unpadded base64url encoding of exactly 32 random
   bytes; generate with Node crypto `randomBytes(32).toString('base64url')`
   and store directly in the secret destination. Never print real secret
   values into chat, logs or committed examples. Keep providers disabled
   until all required local values are configured.
5. The supplied discovery JSON contains tenant
   `f878e345-6d73-477d-8d20-cedf21ede7c6`. Independently verify the exact
   test mailbox domain and tenant-specific v2 discovery before a pilot.
   Public discovery establishes neither student enrollment nor UNILAG
   institutional approval. Local test policy approval is not production
   authorization. Assertion expiry must also be capped by policy approval.
6. Test password fallback, discovery, provider redirect, user-entered
   sign-in/MFA, callback, link and unlink. Record real-provider results
   separately from fixture tests. Enrollment and merchant acceptance need
   their own evidence; a successful login does not complete either gate.

References: [Microsoft account types](https://learn.microsoft.com/en-us/entra/identity-platform/single-and-multi-tenant-apps),
[redirect URI rules](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url).
Implementation evidence: `student-oidc.config.ts`, `config/env.ts`,
`student-sso-link.service.ts` under `apps/backend/src` (config service files
are in `services/auth`).

Documentation impact: operator setup corrections only; no runtime or public
capability changed. No change to trust/help/partner/developer public copy
is needed for this correction. Live credentials, HTTPS provisioning,
provider consent and institutional/merchant acceptance remain unverified.
