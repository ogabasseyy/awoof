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
3. NOT RUN — `STUDENT_SSO_ATTEMPT_KEY` generated (32+ random bytes,
   base64url) and stored as a secret; `STUDENT_SSO_COMPLETION_URL`
   set to the fixed completion route.
4. NOT RUN — Microsoft enrollment Graph (`MICROSOFT_OIDC_*`) confirmed
   operational for any institution piloting Microsoft SSO, since
   Microsoft school assertions require current enrollment evidence.
5. NOT RUN — Support inbox `support@awoof.tech` confirmed monitored
   (account-recovery and mismatch-restart flows point users at it);
   `/privacy` and `/terms` publication status confirmed with the owner.
   Both are outstanding at the time of writing.

## 3. Enablement sequence (all NOT RUN)

1. NOT RUN — Apply migrations through `058` on a disposable copy
   first; confirm `057`/`058` apply cleanly and the consume-once
   triggers reject rewritten handoffs/grants.
2. NOT RUN — Deploy the Release B build to all API instances; confirm
   every instance serves it (mixed-version window stays closed).
3. NOT RUN — With providers still disabled, prove discovery returns
   password-only and the login page shows the no-provider note.
4. NOT RUN — Approve exactly one pilot institution (policy row
   enabled, bounded `approved_until`, named `approved_by`), then
   enable exactly one provider for the pilot.
5. NOT RUN — Canaries, each with a named test account:
   - password login still works; discovery advertises the provider
     for a pilot-domain email and password-only elsewhere;
   - provider return with no matching mailbox stays signed out
     (`link_required`, handoff in tab storage, nothing in the URL);
   - link with reauth binds the new subject, records the school
     assertion, and preserves the existing claim continuation;
   - unlink revokes the identity and its assertions, clears only its
     own session, and leaves enrollment consents untouched;
   - school-account assurance never authorizes benefits: an
     email-only/linked-without-enrollment account still fails every
     benefit consumer.
6. NOT RUN — Real-provider acceptance: one live Google and one live
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
