# Eligibility authority implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Create the canonical, transaction-capable eligibility authority for A02/A05/A08/A13, including explicit institution policy and durable consent/evidence invalidation. Public verification/signup and merchant consumers are wired in dependent plans; this task does not claim those routes fixed.

**Architecture:** Add independent policy, mailbox proof, consent, current-decision and immutable evidence records. A documented common lock order makes every service composable with OTP consumption and later discount redemption. Institution/student generations invalidate proof durably without copying old flags.

**Tech Stack:** Existing TypeScript, PostgreSQL/pg, Zod and node:test/tsx. Reuse challenge migration 029 and the guarded disposable PostgreSQL harness after its Astra approval.

**Spec:** docs/superpowers/specs/2026-09-05-verification-core-remediation-design.md (owner and Astra approved).

## Global Constraints

- Work only in /Users/mac/Downloads/Awoof/.worktrees/verification-remediation on codex/awoof-verification-remediation. Terra implements; Astra reviews. No subagents.
- Preserve others' edits. No dependency installation, push, merge, production/provider requests, VPS deployment or real-user data.
- Approved student-email OTP is first-line `student_email` assurance. Default validity 90 days, configurable 1–365. Stronger `enrollment` proof has a 30-day default cap and explicit provider deadline. Do not require a provider for approved-email assurance.
- No seed/domain auto-approval, no legacy evidence/ownership/consent backfill, no implicit consent and no account merge. Existing verified flags never authorize benefits.
- No Paystack feature work or manual-review/personal-email/retention product decisions. New append-only events describe actual operations, not legal-compliance claims.

### Task 1: Build policy, consent, proof and current eligibility services

**Owned files:**
- Create apps/backend/src/database/migrations/030_eligibility_authority.sql.
- Create apps/backend/src/common/database/transaction.ts.
- Create apps/backend/src/services/verification/eligibility.types.ts, eligibility-context.service.ts, eligibility-policy.service.ts, eligibility-consent.service.ts, eligibility-evidence.service.ts, eligibility-read.service.ts and verification-notices.ts.
- Create apps/backend/src/services/verification/eligibility-policy.service.test.ts and apps/backend/src/testing/postgres/eligibility.integration.ts.
- Modify only the existing subjectDigest helper export/name and its internal call sites in apps/backend/src/services/verification/challenge.service.ts, plus a matching purpose-separation test in challenge.service.test.ts. Export it as challengeSubjectDigest for canonical proof binding; do not change reviewed challenge behavior.
- While touching challenge.service.ts, correct the stale copiedBindings comment that mentions an 8KiB schema ceiling: both canonical storage validation and schema now use 4KiB, with a compact precheck before the canonical query. This is documentation only, not permission to change the bounds or challenge behavior.
- Modify docs/HANDOVER.md only for migration/policy/reverification and service-lock documentation.
- Own this plan's checkboxes. Do not edit existing controllers, routes, frontend or session implementations; the sole challenge change is the narrowly listed digest export/test.

**Shared data types:** Export these from eligibility.types.ts. Use exact external keys below; additional private row types may reflect the schema.

```ts
export type AssuranceMethod = 'student_email' | 'enrollment';
export type EligibilityResult =
  | { eligible: false; reason: 'unverified' | 'expired' | 'inactive' | 'policy_changed' | 'identity_changed' | 'consent_required' | 'enrollment_denied' }
  | { eligible: true; studentId: string; universityId: string; evidenceId: string;
      processingGrantId: string; method: AssuranceMethod; verifiedAt: Date; expiresAt: Date };
export type InstitutionPolicyInput = {
  domains: string[]; emailEvidenceValidityDays: number; enrollmentValidityDays: number;
  registrationNormalization: 'exact' | 'trim_upper' | null; isActive: boolean;
};
export type StudentContext = {
  userId: string; studentId: string; email: string; universityId: string;
  identityVersion: number; policyVersion: number; active: boolean;
};
export type EnrollmentSnapshot = StudentContext & {
  requestGeneration: number; processingGrantId: string; emailProofId: string;
};
export type EnrollmentDecision =
  | { outcome: 'unknown' }
  | { outcome: 'verified'; email: string; registrationNumber: string; validUntil: Date; source: string }
  | { outcome: 'denied'; email: string; source: string };
```

Export `ENROLLMENT_SOURCE = 'institution-registration:v1'` from eligibility.types.ts as the trusted internal adapter tag. Both non-unknown decision types must carry exactly that tag at runtime; it is supplied by the server adapter, never forwarded from arbitrary caller/provider metadata. The institution ID and policy generation identify the configured source instance. The later HTTP adapter must use this same contract.

**Produced interfaces:** All functions below taking `tx` operate inside the caller's open transaction and never commit independently. Failures are existing AppError types or explicit result types, never a success fallback.

Consumed challenge bindings are an inter-task contract (these exact JSON keys must be used by fixtures and later HTTP flows):

```ts
export type StudentEmailChallengeBindings = {
  userId: string; studentId: string; email: string; universityId: string;
  identityVersion: number; policyVersion: number; processingGrantId: string; noticeVersion: string;
}; // student_email subjectKey is authenticated userId, not institution/email input
export type SignupChallengeBindings = {
  email: string; name: string; universityId: string; matricNumber: string | null;
  policyVersion: number; verificationConsent: true; noticeVersion: string;
}; // student_signup subjectKey is normalized email; account IDs do not exist yet
export type AccountEmailChallengeBindings = { userId: string; email: string };
// account_email subjectKey is userId, and its proof is mailbox-only
```

Export those types from eligibility.types.ts; processing noticeVersion must equal VERIFICATION_NOTICE_VERSION at runtime. All email values are normalized. Signup may retain a self-declared matricNumber on the student profile as display data but cannot insert a verified_registration_identities reservation; exact pending claims must match the new account/profile. Existing challenge service stores a server-derived subject digest: compare it as well as JSON bindings by exporting/reusing its existing helper as challengeSubjectDigest(purpose: ChallengePurpose, subjectKey: string): string. Never reimplement a subtly different HMAC. Raw client binding objects are not accepted by these services as proof.

```ts
// common/database/transaction.ts
export function inTransaction<T>(work: (tx: PoolClient) => Promise<T>): Promise<T>;
// eligibility-context.service.ts
export function lockStudentContext(tx: PoolClient, userId: string): Promise<StudentContext>;
export function selectStudentInstitution(tx: PoolClient, userId: string, universityId: string): Promise<StudentContext>;
// eligibility-policy.service.ts
export function normalizeStudentDomain(input: string): string;
export function normalizeMailbox(input: string): string;
export function getInstitutionPolicy(tx: PoolClient, universityId: string): Promise<InstitutionPolicyInput & { policyVersion: number }>;
export function isApprovedStudentEmail(tx: PoolClient, universityId: string, email: string): Promise<boolean>;
export function updateInstitutionPolicy(tx: PoolClient, actorUserId: string, universityId: string, input: InstitutionPolicyInput): Promise<InstitutionPolicyInput & { policyVersion: number }>;
// eligibility-consent.service.ts
export function grantVerificationProcessing(tx: PoolClient, userId: string, universityId: string, action: { accepted: true; noticeVersion: string }): Promise<string>;
export function grantMerchantDisclosure(tx: PoolClient, userId: string, input: { vendorId: string; origin: string; purpose: string; accepted: true; noticeVersion: string }): Promise<string>;
export function withdrawConsent(tx: PoolClient, userId: string, grantId: string): Promise<void>;
// eligibility-evidence.service.ts
export function recordMailboxProof(tx: PoolClient, userId: string, challengeId: string): Promise<string>;
export function recordEmailAssurance(tx: PoolClient, userId: string, input: { challengeId: string; processingGrantId: string }): Promise<EligibilityResult>;
export function beginEnrollmentCheck(tx: PoolClient, userId: string, processingGrantId: string): Promise<EnrollmentSnapshot>;
export function applyEnrollmentDecision(tx: PoolClient, snapshot: EnrollmentSnapshot, decision: EnrollmentDecision): Promise<EligibilityResult>;
// eligibility-read.service.ts
export function getEffectiveEligibility(tx: PoolClient, userId: string, disclosure?: { vendorId: string; grantId: string; origin: string; purpose: string }): Promise<EligibilityResult>;
```

`grantMerchantDisclosure` must validate against an explicit exact-origin widget allowlist, not hostname matching. Migration 030 adds `widget_configs.allowed_origins TEXT[] NOT NULL DEFAULT '{}'` without auto-converting legacy domains. A future widget admin task will let operators configure exact origins. Grants are server-resolved to the live merchant/widget configuration; the function cannot accept an arbitrary active vendor/origin pair merely because they parse. Canonical origin must be HTTPS scheme/host/port with no username, password, path beyond `/`, query or fragment; HTTP is allowed only for explicit local-development configuration (not in test/production by default). Do not expose widget server secrets in grant responses. The existing widget public key is a public config identifier, never merchant server authority.

- [x] **Step 1 — Write RED eligibility tests using the guarded real PostgreSQL harness.** Start from legacy synthetic user `verification_status='verified'`, student and university rows without new proof, call getEffectiveEligibility in a transaction and expect eligible=false. Add a positive fixture built through real policy/grant/challenge/service operations (not direct insertion of a magic positive row). The basic flow is:

```ts
await inTransaction(tx => updateInstitutionPolicy(tx, adminId, universityId, {
  domains: ['students.school.example'], emailEvidenceValidityDays: 90,
  enrollmentValidityDays: 30, registrationNormalization: null, isActive: true,
}));
const grantId = await inTransaction(tx => grantVerificationProcessing(tx, userId, universityId,
  { accepted: true, noticeVersion: VERIFICATION_NOTICE_VERSION }));
// Request a student_email challenge bound to the context/grant; consume it and call
// recordEmailAssurance on the SAME tx. The later flow service will own this sequence.
assert.equal((await inTransaction(tx => getEffectiveEligibility(tx, userId))).eligible, true);
```

Record missing-service/table RED as new-feature RED. Pure domain/notice tests must reject wildcard/suffix/URL/port forms and absent/false/stale consent. Use real SQL for state/race guarantees, not mocks returning convenient rows.

- [x] **Step 2 — Add schema 030 with safe legacy diagnostics.** Detect duplicate students.user_id and duplicate normalized users.email before adding UNIQUE constraints/indexes; fail with a count and operator diagnostic query, never merge/delete people or print private emails in migration logs. Normalize identity comparisons as trim+lowercase consistently; add unique index on lower(btrim(users.email)) without rewriting stored addresses. Drop only the named legacy idx_students_registration_unique reservation index; retain its data. Unproven registration numbers no longer reserve a verified identity. Add students.identity_version default1 and universities.verification_policy_version default1, email_evidence_validity_days default90 (1–365), enrollment_validity_days default30 (1–365), registration_normalization nullable constrained to exact/trim_upper.

Add the following tables with proper FKs/checks/indexes: approved_student_email_domains (exact normalized domain, institution, active flag, approver/time); user_email_proofs (subject, normalized email, consumed challenge, proven time); verification_consents (processing/disclosure type, subject, optional institution or merchant/origin/purpose as required by type, current notice, affirmative action/time, withdrawal); student_eligibility_state (student+institution PK, current_evidence_id, authoritative denial flag, monotonically increasing provider_request_generation); eligibility_evidence (immutable subject/institution/email-proof/grant, method/outcome, identity/policy generations, source, proof time, deadline, revocation/reason); verified_registration_identities (institution, explicitly normalized identifier, student, revocation) with unique active institution+identifier; verification_audit_events (actor, subject/institution as appropriate, event type, minimal versioned metadata, timestamp). No raw provider blob, raw OTP/password/session or gratuitous identity data. Evidence and consent FKs prevent deleting institution history by accident. Audit/evidence update restrictions should allow only the defined revocation fields; policy events are append-only through application interfaces.

Database triggers must bump institution policy generation on actual changes to is_active, evidence caps, normalization or provider configuration; approved-domain insert/update/delete also bumps it. Updating legacy directory domain/email_domains is not approval. Add a student trigger to increment identity_version on actual changes to name, university_id, registration_number or status, and a user-identity trigger to invalidate affected student identity versions when normalized email, role or deleted_at changes. Avoid no-op invalidation and automatic restoration after suspension/role restoration. The student trigger changes only its own row to preserve lock ordering. No evidence/consent/proof backfill. Start approved domains and allowed_origins empty.

The student_eligibility_state row also stores `provider_applied_generation` (initially 0). Under its common lock, application requires the snapshot generation to equal the latest requested generation and be greater than the applied marker; successful application atomically marks it applied. This includes unknown outcomes, which consume the request result without altering current eligibility/evidence/denial. Repeated application of an already-applied generation returns a conflict without mutation, even when the supplied result is identical. This intentionally simple internal contract needs no fabricated idempotent receipt. Rollback restores both the marker and the decision. Provider configuration invalidation includes actual changes to the active registration row's endpoint/config/activity in university_verification_methods, not only universities.database_api_url.

```sql
-- Semantic invalidation never depends on an expiring cron cache:
-- In a BEFORE UPDATE trigger on students:
IF NEW.name IS DISTINCT FROM OLD.name
   OR NEW.university_id IS DISTINCT FROM OLD.university_id
   OR NEW.registration_number IS DISTINCT FROM OLD.registration_number
   OR NEW.status IS DISTINCT FROM OLD.status THEN
  NEW.identity_version := OLD.identity_version + 1;
END IF;
```

- [x] **Step 3 — Implement transaction, lock and policy boundaries.** inTransaction obtains one pool client, BEGIN, awaits the work, COMMIT; on error ROLLBACK and always release. Standard lock order is user row, student row, relevant institution rows ordered by UUID, student_eligibility_state, consent rows, challenge budget/challenge, then assertions/receipts. Withdrawal preserves this order without an active-only check and locks current plus historical grant institutions before consent. Administrative policy operations lock institution only and never later acquire a student lock. Read live admin role/deleted status for policy approval (do not trust a stale JWT role supplied by a controller). All student operations recheck live user role/deleted status and active student/institution. Null/unmatched canonical university cannot become verified. A configured verification method is read normally while its university/version lock is held; it is never `FOR UPDATE`-locked after that university because method triggers also update the institution policy generation. Approved-domain and verification-method `university_id` reparenting is rejected; remove/add is the supported invalidating operation.

```sql
SELECT id, email, role, deleted_at FROM users WHERE id = $1 FOR UPDATE;
SELECT id, university_id, identity_version, status FROM students WHERE user_id = $1 FOR UPDATE;
SELECT id, is_active, verification_policy_version FROM universities WHERE id = $1 FOR UPDATE;
```

Use normalized exact domain equality only; reject wildcards, suffix heuristics, scheme/path/userinfo/ports, invalid domains and generic source inference. Selecting another active institution updates canonical ID and display text together, clears any self-declared registration field, and increments identity generation; it never merges users. Policy PUT validates/normalizes/deduplicates its explicit domain list, records actual approver/time, retires removed domains without erasing history, changes caps/activity/normalization, returns the final generation and records a same-transaction event. A semantic no-op should not invalidate proof. Domain removal/re-addition and suspension/reactivation each produce newer generations.

- [x] **Step 4 — Implement distinct grants and current-decision selection.** verification-notices.ts exports VERIFICATION_NOTICE_VERSION, MERCHANT_DISCLOSURE_NOTICE_VERSION and concise factual display text describing actual email verification/sharing/withdrawal, not legal compliance. Use explicit stable version strings `2026-09-05.v1`. Each grant function validates literal accepted=true at runtime plus current version, subject identity, institution or live merchant/exact origin, then records a fresh affirmative action; no implicit processing-to-disclosure conversion. A disclosure transaction must begin by resolving the candidate merchant without a lock, locking student and candidate-owner users in sorted UUID order, then locking/rechecking active undeleted vendor, active exact-origin widget, student context/state, and consent. It must not follow an already-locked context, plain eligibility read, assurance, or different merchant disclosure unless all participants were predeclared in that sorted entry phase. Live qualified reads use the same order and fail closed if vendor status/deletion, owner role/deletion/mapping, widget, origin, purpose, or disclosure changes. Withdrawal uses subject ownership, is idempotent for that same subject, and cannot withdraw another student's grant. Merchant A withdrawal has no effect on merchant B or separate processing grants. Processing withdrawal denies evidence linked to that grant; granting anew does not revive evidence tied to an old withdrawn grant.

getEffectiveEligibility acquires/reuses the common locks, chooses only the current state pointer, and returns an explicit rejection reason for inactive subject/institution, no positive current evidence, authoritative denial, expiry, revoked evidence, wrong email/identity generation, changed policy generation, missing/withdrawn/stale-version processing consent or a required invalid disclosure. Missing/inactive subjects return eligible=false rather than converting infrastructure errors to false; database failures still propagate. It checks evidence-proven mailbox against the current normalized account email; student_email also checks currently approved exact domain. A consumed OTP's 10-minute challenge deadline is not the resulting evidence's validity deadline, and resending later must not mutate historical proof. The returned private service studentId must not be serialized into merchant-facing callbacks by later consumers. Use database time after locks, not stale transaction-start time. Do not read users.verification_status to grant anything.

- [x] **Step 5 — Implement proof application without external requests.** recordMailboxProof requires an unexpired, consumed account_email/student_email/student_signup challenge whose persisted subject/email bindings match the current non-deleted account; pending signup additionally matches its immutable email/name/institution/matriculation/notice/policy claims. It returns a unique proof ID without granting student eligibility, supporting later ordinary vendor/account mailbox confirmation. No unconsumed/different-subject challenge can produce ownership. Reusing the same challenge for the same already-recorded mailbox fact is idempotent, never a second proof; different-subject reuse is forbidden. Existing account-email fixture and future route consumption lock the account in the same transaction before challenge budget/consume/proof; existing student-email consumption additionally locks canonical context, state, and processing grant in that transaction. Only genuine new-account `student_signup` consumes before those subject rows exist. recordEmailAssurance requires a consumed challenge row with purpose student_email or student_signup whose persisted bindings exactly match user/email/institution/identity/policy/processing grant and notice. Signup's pending bindings can omit not-yet-created IDs only when the caller attaches the actual affirmative processing grant and newly created account in the same transaction; check challenge email, name, canonical institution, exact stored self-declared matriculation value (including null), policy, and notice against that account. It must reject an unconsumed, different subject, reused evidence-bound, expired or stale-bound challenge. Reuse recordMailboxProof and create student_email evidence with 90-day/configured expiry atomically; update current state only if no authoritative denial. The challenge is uniquely attached to evidence so it cannot issue repeated assurances. Validate persisted binding values, not caller-supplied replacements. Self-declared matriculation never reserves a verified registration identity.

beginEnrollmentCheck requires current mailbox proof, active processing consent and an explicitly configured active enrollment adapter; lock context/state, increment provider_request_generation and return its immutable snapshot. It performs no HTTP call. applyEnrollmentDecision relocks/rechecks exact subject/email/identity/policy/grant/mailbox and request generation, rejecting out-of-order/stale completions. Unknown does not manufacture evidence or clear an existing denial/positive. Positive requires provider-attested email equality, explicit registration identifier, a valid finite future provider deadline capped to configured enrollment validity and nonempty trusted source tag; apply explicit institution normalization before reserving the canonical verified identifier. A reservation for another student is conflict, never merge. If normalization is unconfigured, return unavailable instead of guessing. A valid newer authoritative negative appends a denied decision, sets authoritative denial and removes the positive current pointer; subsequent student_email proof cannot override it. A newer valid authoritative positive can clear it. Manual overrides are not added in this task.

Both positive and denied provider results must have a normalized provider-attested email equal to the proven mailbox/snapshot/current account, plus the exact trusted ENROLLMENT_SOURCE tag, before any evidence/state/registration mutation. Rechecking the request snapshot alone is not validation of decision.email. Mismatched-denial or untrusted-source results are rejected without consuming the application marker. A same-generation denial followed by a positive must conflict and remain denied; only a newly begun, newer valid request may clear the denial.

- [x] **Step 6 — GREEN full real-database acceptance.** Cover legacy flag denial; exact approved-domain success and website/general domain rejection; no implicit domain approval from CSV-like directory writes; controlled-timestamp expiry and 90-day/configured email plus provider/policy caps; fresh policy/domain removal/re-addition, suspension/reactivation, material profile/email changes and changes back; case-only email no-op; one-profile/normalized-email concurrent uniqueness; missing/false/stale/foreign consent; independent merchant withdrawals; active vendor/owner/widget/origin authority; processing withdrawal/regrant does not revive old evidence; forged or reused challenge/proof references; null/value/mismatched signup matriculation and new-account one-transaction proof creation; positive-to-authoritative-negative-to-email retry remains denied; unknown leaves prior current decision unchanged; newer positive clears denial; mismatched denied-email and untrusted source for both outcomes cause no mutation; repeat/identical application conflicts; same-generation denial-to-positive conflicts and stays denied; unknown also consumes its application generation; out-of-order provider results and profile/policy/grant/provider-method changes during a provider snapshot are rejected; same registration string at different institutions is independent; same verified identity at one institution conflicts without merge. Use controlled `pg_blocking_pids` two-client barriers to prove merchant, profile/email/policy, withdrawal/read/application, provider-method/begin/apply ordering; prove concurrent application/duplicate identity winners and exact rolled-back pointer/evidence/proof/marker/reservation restoration. Test duplicate legacy migration diagnostics in a separate synthetic fixture database/schema, never in an existing DB.

- [x] **Step 7 — Validate and commit.** Run npm run test:postgres, npm test, npm run type-check, npm run lint and git diff --check in backend/worktree as appropriate; record exact results. Document lock ordering, schema/approved-policy setup and legacy reverification in HANDOVER without claiming current UI/routes/launch complete. Mark checks, self-review, commit owned files and this plan as `feat(verification): establish explicit eligibility authority`; write assigned scratch report including interfaces and unimplemented consumer boundary. Do not claim A01 or A12 closed until route/flow tasks land.
