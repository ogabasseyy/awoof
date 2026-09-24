# Legal publication authorization — 23 September 2026

The owner reported “lawyer approved” after review of the local five-document package, then explicitly instructed “make it live”. This records the owner's report and publication authorization, not an independent opinion or identity verification of counsel.

Release version: 1.0, dated 23 September 2026. Public routes: /legal, /privacy, /terms, /cookies, /legal/merchant-terms and /legal/data-protection. The public review guide is replaced with a reader-facing directory. The counsel memorandum and draft reading copy remain internal repository documents, not web routes.

Publication edits remove draft/proposed labels and add version, canonical metadata, sitemap and footer/auth-navigation links. Substantive statutory exceptions, source/enrollment distinctions and contract-execution conditions remain intact. The operator is identified using the owner-provided registered business name and number without asserting limited-company status. Each partner's executed order must identify the actual contracting parties.

Publishing does not create historical terms acceptance, university authority or merchant contracts. Merchant agreements require an accepted order form; data-processing schedules require completed annexes. No new retention jobs, age checks, provider-location guarantees, payment schedules or institutional integrations are represented as implemented. Proposed retention durations and unresolved operating details in the counsel memorandum are not promoted to public promises by this release.

## Documentation impact

1. Public legal pages and navigation now expose approved policies, separate from Trust/help guidance.
2. Privacy/terms/storage and conditional partner documents updated together; internal legal-review history retained.
3. Source-evidence references remain in legal-review-handoff.md; no claim that code review proves deployment or partner activation. Live publication requires PR checks, merge, deploy success and HTTP/content checks.
4. Regression coverage includes six routes, single H1, section anchors, 320px layout, canonical/indexing metadata, sitemap/footer destinations and merchant execution boundary.
5. Owner-reported counsel approval and publication permission recorded above. Operational annexes, applicable entity details and any required acceptance/notice rollout must still be completed before relevant partner services or changed contractual obligations are applied.

## Owner-authorized student policy update — 24 September 2026

The owner authorized an 18+ student-account launch and this signup-policy change. Proposed release 1.1 updates the student Terms and privacy notice: creating a student account will require an unchecked-by-default self-declaration of age 18 or older and acceptance of the current Terms. The declaration is not independent age verification; no NIN, BVN or identity document is collected for it. The service records the declaration, accepted Terms version and server timestamp together. Existing acceptance rows are not marked age-attested, existing accounts are not blocked from login, and school-account control or enrollment eligibility is not inferred from this declaration. Provider identities that are not yet linked continue through password signup and the same required declaration before linking; ordinary sign-in is unchanged.

The approved 1.0 student Terms reading copy is preserved at immutable merge commit `889bb391b6a743ce397433e70e2a1eb6ccb2800c`, file `apps/web/src/content/public/terms-draft.ts`, and published as a frozen public archive at `/terms/v1-0` (linked from the current Terms and legal index). Existing acceptances keep their recorded 1.0 version; the 1.1 page is intended for new signup acceptance after rollout and does not rewrite historical records.

Implementation evidence: `apps/backend/src/database/migrations/068_student_terms_age_attestation.sql`, `services/auth/student-signup.service.ts`, `controllers/auth.controller.ts`, `apps/web/src/app/auth/student/register/page.tsx`, and the focused signup/browser tests. The update is source and test evidence only until merged and deployed; the public site remains on release 1.0 until then. No live provider, production setting or customer record was changed by this branch.

The generic legal-page wrapper no longer presents merchant order-form execution and completed processing annexes as conditions applying to student Terms or the privacy notice. Those boundaries appear only on the relevant merchant and partner data-protection pages. No merchant agreement is created by this change.

### Owner-directed rollout exception — 24 September 2026

- After being shown the exact version 1.1 eligibility, collection and retention wording and asked whether approval was from counsel or the business owner, the owner explicitly answered: “business owner approved. fix what u said to fix and merge”. This records business-owner approval and an explicit instruction to proceed despite the previously documented counsel-review gate; it is not lawyer approval or a legal-compliance opinion.
- Scope: the 18+ self-declaration requirement, collection of the declaration with Terms version and server timestamp, and retention with agreement evidence, qualified as “version and time, and an age declaration where recorded” so historical records are not misrepresented.
- Independent legal review of version 1.1 remains unconfirmed. The version 1.0 counsel approval is not extended to version 1.1. This owner-directed exception supersedes the previous merge/deploy hold for this release only; normal CI and technical review gates remain required. Production deployment—not merge—publishes the new indexed text and begins requiring acceptance of version 1.1. A merge or a failed deployment is not evidence of publication.
- The candidate public label states version 1.1 as effective 24 September 2026. Before production rollout, compare that label with the actual planned deployment date. If deployment occurs after September 24, update the label and its tests to the actual rollout date through the reviewed release before publishing; do not deploy a stale effective date. After deployment, verify the rendered Terms/privacy date and active signup Terms version, and record the actual rollout date and deployment evidence. Recheck the date after any deployment delay or retry, including delays after merge.
