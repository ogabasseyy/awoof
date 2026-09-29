# Task 5 account recovery report

## RED

- Added the account-recovery service contract test before its module existed; the targeted test failed with `ERR_MODULE_NOT_FOUND`.
- Added the legacy marker reset test before changing the controller; it failed because the reset lookup lacked `password_setup_requires_recovery_code = false`.
- Added the account-recovery router contract test; it initially failed because `/:provider/start` captured the recovery start route. The recovery routes now register before that parameterized route.

## GREEN (local)

- Targeted unit/router/controller tests: 31 passing.
- `npm run type-check`: passing.
- `git diff --check`: pending final controller-run snapshot.
- Controller PostgreSQL run exposed a shared verifier defect: recovery verification compared plaintext recovery codes directly to the stored HMAC digest. The service now derives the same deployment-keyed digest before constant-time comparison; this retains the existing recovery-code storage contract.
- The controller PostgreSQL run had one intentional skip: the dedicated compiled-fallback smoke requires its source-absent selector and is outside this broad/source suite. It is not represented as a pristine all-green run.
- The controller's next run showed the recovery OTP budget assertion was reading an unrelated recovery budget in the shared fixture database; the test now joins its exact recovery attempt to its challenge and budget. The session gate was also narrowed so absent and ordinary deleted students retain existing downstream live-identity handling; only marker/recovery-policy students are rejected early when their bound session is stale.
- Real-PostgreSQL tests now cover lost-access recovery; compromise identity/assertion revocation while preserving an independent enrollment record under a disabled/expired provider policy; suspended and pending-code denial; immutable purpose substitution; terminal replay; rollback; recovery versus code-replacement; and provider finish versus compromise recovery. Per coordination, the full PostgreSQL suite has not been run by this worker.

## Behaviour delivered

- Added migration 073 for an isolated `student_account_recovery` OTP purpose; it retains the specified five-failure, three-send, 60-second resend controls and five-minute OTP lifetime capped by the ten-minute recovery attempt.
- Added start/verify/complete account-recovery operations and public routes. Attempts bind their server-held purpose, secret, active recovery-code generation, and mailbox challenge. Unknown/suspended/code-less accounts receive a non-verifiable generic start handle.
- Completion consumes active and pending recovery codes, increments credential generation, revokes sessions/action grants, installs a policy-valid password without auto-login, and sets the post-recovery password-proof re-enrollment marker atomically.
- Compromise recovery revokes only linked external identities and identity-scoped school assertions. It deliberately does not delete independent enrollment evidence.
- Passwordless signup now writes the durable legacy-reset marker. Legacy forgot/verify/reset paths all exclude marker accounts, including after optional password setup.

## Documentation impact

No public trust/developer copy was changed. The feature is not deployed or enabled: `STUDENT_ACCOUNT_RECOVERY_CODE_KEY` remains intentionally absent, and provider/key rotation plus production validation are Task 7 release work. Before publication, update the recovery/login/help disclosure to state the school-mailbox limitation and no guaranteed recovery, with evidence and owner acceptance; do not claim provider-independent mailbox access or enrollment verification.

The effective recovery-code key is `STUDENT_ACCOUNT_RECOVERY_CODE_KEY` when explicitly configured, otherwise the established `STUDENT_SSO_ATTEMPT_KEY` used by migrations 069–072. Do not rotate either existing effective key without a reviewed rekey migration: active code digests are not portable. Provider disablement is independent from retaining that key.

Student access-token authentication now has a durable users-table availability dependency: it reads the recovery-policy marker for every student so older JWTs without a marker claim cannot bypass recovery invalidation. A database lookup outage is deliberately surfaced as retryable 503 for both required and optional student authentication; optional authentication does not attach an identity during that outage. Vendor/admin JWT verification remains cryptographic-only. Release validation must include database-outage behavior and monitoring for this lookup.

## Not ready for full completion

The full real-PostgreSQL suite must still validate the added integration tests. This worker did not run the full suite by coordination instruction and does not mark Task 5 ready.
