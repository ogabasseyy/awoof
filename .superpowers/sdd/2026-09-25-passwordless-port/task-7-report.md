# Task 7 — retention, disclosure, and release evidence

## Implemented source changes

- Extended the existing `sso:cleanup` path (rather than adding a dispatcher) to revoke/scrub expired action-grant digests at the one-hour boundary, preserve active recovery-code credentials, scrub expired pending recovery-code credentials, and remove terminal action/recovery tombstones after seven days.
- Added migration 074 to permit only terminal secret scrubbing for the affected passwordless transient rows while retaining immutable owner, purpose, identity, and expiry bindings.
- The CLI emits fixed redacted failure output and exits non-zero for remaining overdue state. This is an alertable signal; no real alert delivery is claimed.
- Made the compiled artifact require and source-absent probe `cleanup-student-sso.js`, including credential redaction behavior.
- Added a PostgreSQL cleanup regression expectation for an expired action-grant digest and preserved active credentials.
- Removed the incorrect generate-purpose redirect intent from the recovery-code removal initiation flow.
- Corrected migration 074 in place before sharing or deployment: it now permits only the pre-existing canonical pending signup challenge reference update and single handoff owner/session consumption transition, while continuing to reject later binding changes and replay. Fresh disposable PostgreSQL application is required evidence for this unshared migration edit.

## Public documentation impact

Affected inventory: `/help`, `/trust`, `/privacy`, `/developers`, partner integration copy, and OpenAPI were assessed. The implementation routes/contracts already document the passwordless endpoints; this task adds the explicit internal trust-inventory boundary and release checklist rather than publishing a route or claiming activation. No public page says a mailbox, school login, or OTP proves current enrollment. No new legal terms, service level, MFA, university-partnership, or universal-recovery claim was introduced.

Evidence links source cleanup to migration 074 and the compiled artifact. Deployment, configured scheduling, provider validation, merchant enforcement, and alert delivery remain release gates, not completed behavior.

## Fresh local evidence

- `npm run type-check --prefix apps/backend` — passed.
- `npm run test:artifact --prefix apps/backend` — passed: compiled artifact contained 29 integration tests, 75 staged migrations, and 724 hashed files; OpenAPI artifact parity and source-absent runtime probes passed.
- `npm test --prefix apps/backend` — passed: 375 tests, 0 failures, 0 skipped. Four HTTP fixtures now use scoped, restored pool stubs matching the passwordless student-session lookup; the recovery-status expectation includes the deliberate `pendingCodeId: null` contract field.

## Not run / release blockers

- The full PostgreSQL suite, backend lint, web typecheck/lint/build, and browser suite were intentionally left to the release controller; this report does not claim their results.
- Production activation is blocked pending owner acceptance of mailbox limitations; secure Azure configuration inspection; user-operated Microsoft/MFA/consent exercise with `auth_time`; signup/session persistence/subsequent login/denied-benefit evidence; and demonstrated external cleanup-alert delivery.
- Backend-first deployment with signup disabled, an old-client/new-backend contract test, and a rollback that retains credential protections are required by `docs/passwordless-release-checklist.md`.
