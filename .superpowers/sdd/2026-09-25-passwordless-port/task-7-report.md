# Task 7 — retention, disclosure, and release evidence

## Implemented source changes

- Extended the existing `sso:cleanup` path (rather than adding a dispatcher) to revoke/scrub expired action-grant and pending recovery-code digests at expiry. With the existing 15-minute job this is inside the one-hour maximum; active recovery-code credentials survive cleanup and terminal action/recovery tombstones are removed after seven days.
- Added migration 074 to permit only terminal secret scrubbing for the affected passwordless transient rows while retaining immutable owner, purpose, identity, and expiry bindings.
- The CLI emits fixed redacted failure output and exits non-zero for remaining overdue state. This is an alertable signal; no real alert delivery is claimed.
- Made the compiled artifact require and source-absent probe `cleanup-student-sso.js`, including credential redaction behavior.
- Added PostgreSQL cleanup boundary regressions for expiry terminalization, active recovery-code survival, seven-day terminal deletion, and a deleted terminal grant’s inability to become usable again.
- Removed the incorrect generate-purpose redirect intent from the recovery-code removal initiation flow.
- Corrected migration 074 in place before sharing or deployment: it now permits only the pre-existing canonical pending signup challenge reference update and single handoff owner/session consumption transition, while continuing to reject later binding changes and replay. Fresh disposable PostgreSQL application is required evidence for this unshared migration edit.

## Public documentation impact

Affected inventory: `/help`, `/trust`, `/privacy`, `/developers`, partner integration copy, and OpenAPI were assessed. `/help` now states only that recovery uses its product flow and that mailbox control neither transfers an account nor proves enrollment. `/developers` explicitly excludes disabled/unvalidated student sign-in and recovery routes from the public merchant API. `/trust` and the owner-approved `/privacy` source have an explicit no-change rationale in `docs/public-trust-pages.md`; no legal commitment was changed. OpenAPI now has strict request bodies, typed success schemas, bearer/no-bearer security declarations, and malformed/origin/auth/replay/rate-limit failure responses for signup, fresh reauthentication/recovery-code, and independent-account-recovery endpoints. No public route claims activation.

Evidence links source cleanup to migration 074 and the compiled artifact. Deployment, configured scheduling, provider validation, merchant enforcement, and alert delivery remain release gates, not completed behavior.

## Fresh local evidence

- `npm run type-check --prefix apps/backend` — passed.
- `npm run test:artifact --prefix apps/backend` — passed: compiled artifact contained 29 integration tests, 75 staged migrations, and 724 hashed files; OpenAPI artifact parity and source-absent runtime probes passed.
- `npm test --prefix apps/backend` — passed: 377 tests, 0 failures, 0 skipped. Four HTTP fixtures now use scoped, restored pool stubs matching the passwordless student-session lookup; the recovery-status expectation includes the deliberate `pendingCodeId: null` contract field.
- `npm run test:postgres --prefix apps/backend` at final source — passed: 393 tests, 0 failures, 1 skipped; the disposable cluster freshly applied migration 074.
- `npm run lint --prefix apps/backend` — passed with 0 errors and 47 warnings.
- `npm run lint --prefix apps/web` — passed with 0 errors and 52 warnings.
- `npx tsc --noEmit --pretty false` from `apps/web` — passed. The package has no `type-check` script, so the project compiler was invoked directly.
- `npm run build --prefix apps/web` — passed; Next.js built 74 routes.
- `npm run test:browser --prefix apps/web -- tests/browser/passwordless-recovery.spec.ts` — passed: 9 tests. The initial dropped-generation failure was a test-fixture synchronization race: the status mock could read before its simulated lost response had recorded the server-pending write. The test now awaits that mocked write; application behavior remains server-status-only and does not persist/reveal a plaintext code.

## Not run / release blockers

- The full browser diagnostic previously ran while source changed. Its two affected recovery cases have a final-head focused pass above; a full browser rerun remains a release-controller gate if required by review policy.
- Production activation is blocked pending owner acceptance of mailbox limitations; secure Azure configuration inspection; user-operated Microsoft/MFA/consent exercise with `auth_time`; signup/session persistence/subsequent login/denied-benefit evidence; and demonstrated external cleanup-alert delivery.
- Backend-first deployment with signup disabled, an old-client/new-backend contract test, and a rollback that retains credential protections are required by `docs/passwordless-release-checklist.md`. Local compatibility coverage proves legacy `/google/start` remains available while new `/signup/context` is disabled by default.
