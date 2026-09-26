# Task 5 account recovery report

## RED

- Added the account-recovery service contract test before its module existed; the targeted test failed with `ERR_MODULE_NOT_FOUND`.
- Added the legacy marker reset test before changing the controller; it failed because the reset lookup lacked `password_setup_requires_recovery_code = false`.
- Added the account-recovery router contract test; it initially failed because `/:provider/start` captured the recovery start route. The recovery routes now register before that parameterized route.

## GREEN (local)

- Targeted unit/router/controller tests: 31 passing.
- `npm run type-check`: passing.
- `git diff --check`: pending final controller-run snapshot.
- A real-PostgreSQL test was added for lost-access recovery, active-code consumption, no automatic session, re-enrollment restriction, and preserving linked identity. Per coordination, the full PostgreSQL suite has not been run by this worker.

## Behaviour delivered

- Added migration 073 for an isolated `student_account_recovery` OTP purpose; it retains the specified five-failure, three-send, 60-second resend controls and five-minute OTP lifetime capped by the ten-minute recovery attempt.
- Added start/verify/complete account-recovery operations and public routes. Attempts bind their server-held purpose, secret, active recovery-code generation, and mailbox challenge. Unknown/suspended/code-less accounts receive a non-verifiable generic start handle.
- Completion consumes active and pending recovery codes, increments credential generation, revokes sessions/action grants, installs a policy-valid password without auto-login, and sets the post-recovery password-proof re-enrollment marker atomically.
- Compromise recovery revokes only linked external identities and identity-scoped school assertions. It deliberately does not delete independent enrollment evidence.
- Passwordless signup now writes the durable legacy-reset marker. Legacy forgot/verify/reset paths all exclude marker accounts, including after optional password setup.

## Documentation impact

No public trust/developer copy was changed. The feature is not deployed or enabled: `STUDENT_ACCOUNT_RECOVERY_CODE_KEY` remains intentionally absent, and provider/key rotation plus production validation are Task 7 release work. Before publication, update the recovery/login/help disclosure to state the school-mailbox limitation and no guaranteed recovery, with evidence and owner acceptance; do not claim provider-independent mailbox access or enrollment verification.

## Not ready for full completion

The full real-PostgreSQL suite must still validate the added integration test and the remaining brief-required compromise, provider-disabled/expired-policy, suspension, replay/purpose substitution, pending-code, rollback, replacement-race, and callback-race cases. This worker did not run that suite by coordination instruction and does not mark Task 5 ready.
