# Awoof audit remediation progress

Source audit: /Users/mac/Downloads/Awoof/docs/audits/2026-09-05-student-verification-audit.md at application commit 3a5b3d4.
Worktree: /Users/mac/Downloads/Awoof/.worktrees/verification-remediation
Branch: codex/awoof-verification-remediation
Owner-requested allocation: Terra implementation, Astra review.

## Owner decisions

- Isolated worktree approved; PR #20 remains remotely unchanged.
- Student-email OTP is the first-line verification method for approved student-email domains, with periodic re-verification and stronger evidence when school email rules are insufficient. Do not require authoritative enrollment data everywhere.
- Written verification-core design approved, including 90-day configurable assurance, 10-minute OTP, 5 failed attempts and 60-second resend cooldown; authenticated verification, separate merchant consent, and legacy re-verification. Astra's concurrency/identity/consent clarifications incorporated without changing this policy.
- Paystack work remains deferred. Payment-independent verification and narrowly required redemption-integrity repairs remain in scope.
- No production deployment, merge or push is part of this implementation run.

## Findings tracker

| Audit finding | Code workstream | Status/evidence |
|---|---|---|
| A01 identity binding | Evidence and authenticated verification | Pending |
| A02 assurance separation | Approved student-mail evidence, owner policy above | Pending; original audit concern must be resolved through explicit assurance, not by rejecting email as a method |
| A03 provider decisions | Strict provider contract and identity binding | Pending |
| A04 email domain policy | One exact approved-student-domain policy | Pending |
| A05 expiry/re-verification | Effective eligibility authority | Pending |
| A06 atomic redemption | Merchant verification exchange and transaction integrity | Pending |
| A07 private documents | Private storage and authorised reads, legacy protection | Pending |
| A08 genuine consent | Versioned subject/merchant grants | Pending |
| A09 web type errors | Web-client repair plan | Fixed in 707c96e; Astra spec/quality approved; compiler RED then GREEN, lint 51 existing warnings |
| A10 widget delivery | Reproducible published artifact and docs | Pending |
| A11 merchant contract | Payment-independent exchange and example connector | Pending |
| A12 challenge abuse | Atomic bounded challenge service | Primitive8131e6c with follow-ups through1741fb3;18 PostgreSQL/22 normal/5 lifecycle tests reported pass. Astra approved cleanup/JSON safety implementation and session matrix but round3 must correct lifecycle subprocess fixtures and boundary assertions. Route migration remains required |
| A13 identity continuity | Canonical evidence identity and invalidation | Pending |
| A14 refresh authority | Durable refresh sessions plan | Implemented325b1bc, Astra spec/quality approved. Real SQL status/revocation/reset-race tests added8131e6c and passing; fixture code is undergoing Astra review |
| A15 uploads | Content validation, role-first upload, cleanup/limits | Pending |
| A16 merchant keys | Serialised lifecycle and real quotas | Pending |
| A17 release readiness | CI/CD guards, artifact checks, recovery drills | Code pending; live restore/VPS parity will remain separately unverified |
| A18 honest methods | Configured/implemented availability only | Pending |

## Additional audit scope

Manual-review/appeal tooling, privacy rights/retention controls, merchant pseudonyms and minimal claims, reference merchant integration, and full validation need separate tracked implementation and acceptance evidence. Institution partnerships, approved domain inventory, legal policy review, real provider quality, live backups/restores, and country launch validation cannot be fabricated by coding agents.

Additional issue observed during remediation (not a rewrite of the source audit): verifyResetOTP in auth.controller.ts issues an ordinary access JWT with a hardcoded student role, while reset UIs ignore that resetToken and later resubmit the OTP. Track a bounded purpose-bound password-reset grant repair, atomic OTP/reset consumption and matching frontend transport after the core authority task. This was not fixed by A14's refresh-session patch.

Bounded reset planning is recorded in docs/superpowers/specs/2026-09-05-password-reset-repair-notes.md, including the observed logged-in password-update compare/write race and preserving refresh revocation. It is not an implementation or changed password policy.

Owner asked asynchronously whether assisted document review belongs in this first release or a later phase; no answer yet. Core email OTP and merchant integration remain approved and can proceed independently.

## Verified baseline and constraints

- Baseline backend: 8 tests passed, type check passed. Existing lint: 38 backend warnings, 51 web warnings.
- Only about 2.5 GB free at setup. Existing node_modules are linked read-only; do not install/update through those links. Large builds require a fresh disk check.
- The sole parent-branch setup commit 007491d adds `.worktrees/` to `.gitignore`; no application change was made on the original PR branch.
- Original audit remains unchanged in the original checkout. This tracker is not a replacement or a claim that pending findings are fixed.

## Agent and review records

- /root/terra_identity_design: read-only design of identity migration, owner policy and frontend dependencies.
- /root/terra_web_client_fix: 707c96e, task report under `.superpowers/sdd/2026-09-05-web-client-repair/`.
- /root/astra_web_client_review: spec PASS, quality Approved; no critical/important/minor findings.
- /root/terra_durable_sessions: A14 implemented 325b1bc; report/ledger under `.superpowers/sdd/2026-09-05-durable-refresh-sessions/`.
- /root/astra_durable_sessions_review: spec PASS, quality Approved, no Critical/Important findings. Minor test-label concern tracked for real database validation rather than treating zero-row doubles as proof of actual status predicates.
- /root/astra_verification_design_review: all six Important engineering-contract clarifications incorporated and re-review approved for implementation; launch readiness not asserted.
- /root/terra_challenge_foundation: migration029 and challenge primitive implemented8131e6c;14 real PostgreSQL tests,21 normal tests, type/lint pass; Astra review in progress. Metadata hygiene correction requested separately.
- /root/terra_release_design: read-only A10/A17 file/interface contract completed; source repair notes preserved under docs/superpowers/specs/2026-09-05-release-repair-notes.md.
- /root/terra_private_upload_design: read-only A07/A15 mutation/access map completed; source repair contract preserved under docs/superpowers/specs/2026-09-05-private-upload-repair-notes.md. Existing vendor-document privacy work is separate from the pending manual student-review product decision.
- /root/astra_eligibility_plan_review: independent read-only check of the next bounded eligibility plan before Terra implementation; no source completion claim.
- Disk rechecked after owner's continue: 21 GiB available; no cleanup/deletion performed by this task. Database validation can proceed with a fresh guard at startup.

All future completion claims require commits, covering tests and an Astra review; local success, CI, merge and production deployment remain distinct.
