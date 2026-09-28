# Passwordless student sign-in release checklist

Status: **not approved for activation**. This checklist describes the release gate for source changes on this branch; it is not deployment evidence.

## Backend-first rollout and rollback

- [ ] Apply migrations 069--078 and deploy the backend before any web client that invokes the passwordless routes. Migration 075 replaces 072's immutable-binding trigger so activation can scrub pending-only bindings; without it every recovery-code activation fails. Migration 076 extends that scrub to revoked rows (cancel, supersede, remove, recovery consumption, expiry cleanup); without it those terminalizations fail. Migration 077 drops the legacy reauth-grant digest uniqueness so recovery can scrub multiple retained rows; without it a second retained row aborts the recovery transaction. Migration 078 adds the reauth processing claim so duplicate provider callbacks redeem once; without it a duplicate redemption can fail the winner's attempt.
- [ ] Keep student SSO signup disabled until every gate below is evidenced. Disabled signup must return the documented bounded response; existing account sign-in and owner recovery remain separately controlled.
- [ ] Exercise an old web client against the new backend before enabling signup. It must continue normal supported sign-in without interpreting passwordless payloads as eligibility.
- [ ] If rolling back the web client, keep the new backend credential protections and migrations in place. Once passwordless accounts exist, do not restore a legacy email-only recovery binary or path.
- [ ] Confirm the production cleanup job invokes `sso:cleanup:prod` at least every 15 minutes and that its runtime has the credential keys and database access it needs.

## Owner-operated evidence required before activation

- [ ] The owner accepts the limitation: mailbox availability and a school login do not by themselves prove current enrollment, and recovery requires the documented proofs.
- [ ] Securely inspect the existing Azure app/tenant configuration, redirect URLs, credentials, consent configuration, and environment separation; do not paste secrets into this document or tickets.
- [ ] Run a user-operated Microsoft test including MFA/consent where applicable. Capture only safe evidence that `auth_time` is present and fresh enough for the flow.
- [ ] Demonstrate disabled-signup behavior, approved signup, session persistence after reload, a later normal login, and a denied-benefit result without current enrollment evidence.
- [ ] Demonstrate a real cleanup failure and overdue-expired-state alert reaching the accountable owner. Local stderr/exit status is alertable signal only; alert delivery is still pending.

## Documentation-impact checklist

1. Affected pages: `/help`, `/trust`, `/privacy`, `/developers`, partner integration copy, OpenAPI, and this internal trust inventory.
2. Public wording must distinguish source/tests from deployed/enabled behavior; it must not claim a university partnership, current-enrollment proof from login, MFA, or universal recovery.
3. Evidence is source migrations 069--078, cleanup command output/tests, route/OpenAPI contracts, and this gate list. Deployment, provider, merchant, and alert-delivery evidence remain pending.
4. Before release, check rendered links/contact destinations, headings, keyboard navigation, labels, and mobile layout.
5. No new legal commitment is made here. Any new data-sharing, retention-policy, vulnerability-disclosure, or response-time commitment needs owner/legal/operations approval.
