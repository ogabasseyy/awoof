# Passwordless transient-retention final fix

## Scope and outcome

The final review found that `student_auth_signup_challenges.handoff_id` is a
non-cascading foreign key. The old cleanup deleted seven-day-old handoffs
without removing completed signup children first, so one aged completed signup
could abort the cleanup transaction and prevent later transient cleanup.

This fix makes SSO transient cleanup one transaction, terminalizes/scrubs the
new signup, reauthentication, and recovery attempts, deletes their seven-day
tombstones before handoffs, and then removes eligible attempts. It does not
delete durable identities, assent/proof records, or active recovery-code
credentials.

Successful passwordless signup now clears handoff and signup secret/binding
material. Successful recovery clears its attempt secret. Successful fresh
reauthentication clears its state, callback-cookie, verifier, and nonce. OTP
digests for only `student_sso_signup` and `student_account_recovery` are
cleared at successful consumption; the existing challenge dispatcher also
purges expired rows for those purposes at expiry (its one-minute schedule is
stricter than the one-hour deadline). Existing/legacy challenge purposes keep
their 24-hour contract.

## Regression coverage

- Real PostgreSQL completed-signup fixture creates an aged consumed signup
  child, its non-cascading aged handoff, later action-grant/recovery-code work,
  aged reauth, and aged recovery attempts. Cleanup commits, removes children
  before the handoff, continues through the later tables, and a deleted signup
  cannot be replayed.
- Successful signup asserts that handoff, signup, and signup-OTP digests are
  immediately scrubbed.
- Successful recovery asserts that its attempt secret and recovery-OTP digest
  are immediately scrubbed.
- The cleanup fixture preserves the active recovery-code digest and validates
  seven-day deletion for terminal action grants, signup challenges, reauth
  attempts, recovery attempts, handoffs, and ordinary SSO attempts.

## TDD evidence

The pre-fix source PostgreSQL run was captured in
`/private/tmp/awoof-retention-red-captured.log`: exit 1, 394 tests total,
390 passed, 3 failed, 1 skipped, duration 131550 ms. The three expected
failures were: successful signup secret/digest retention, successful recovery
secret/digest retention, and PostgreSQL error `23503` when cleanup attempted
to delete the handoff before its signup child.

The final source PostgreSQL run is captured in
`/private/tmp/awoof-retention-final-pg.log`: 394 tests total, 393 passed,
0 failed, 1 skipped, duration 131654 ms.

## Verification

- `npm run type-check` (backend): passed.
- `npm run test:postgres` (backend): 393 passed, 0 failed, 1 skipped.
- `npm test` (backend): 377 passed, 0 failed.
- `npm run test:artifact` (backend): passed; compiled artifact, OpenAPI parity,
  source-absent rendered Swagger probe, and compiled cleanup probes passed.
- `git diff --check`: passed.

## Documentation impact

No public page, API schema, `/developers`, partner copy, or trust claim was
changed. This is an internal retention implementation correction and does not
change a user-visible contract or establish a deployed/enabled retention
claim. Existing public documentation must not be read as production evidence;
provider/deployment alert-delivery and scheduled-job operation remain separate
release gates.

## Remaining gates

This local change has not been pushed, deployed, provider-enabled, or merged.
Review the exact commit and run the repository PR/release gates separately.
