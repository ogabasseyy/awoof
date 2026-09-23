# Awoof legal-page review ledger

## Publication status — 23 September 2026 (release v1.0, current)

The owner reported lawyer approval of the five-document package and explicitly authorized publication; see [the publication authorization record](legal-publication-approval.md). Release v1.0 (effective 23 September 2026) publishes `/legal`, `/privacy`, `/terms`, `/cookies`, `/legal/merchant-terms` and `/legal/data-protection` as indexed (`index, follow`) routes linked from the footer, auth navigation and sitemap. The sections below are the retained pre-publication review ledger: operator facts, source evidence, research and gates stay valid background, but the draft-only status, noindex instructions and "do not publish" gates are superseded for this exact approved version. Future text changes need fresh review, versioning and sign-off before they become effective.

## Historical review status (superseded at publication)

Prepared 2026-09-23 for owner and legal review. Before authorization, `/privacy` and `/terms` intentionally used `noindex` and were absent from the footer, page-metadata registry and sitemap.

The expanded package was indexed at `/legal`: student/website terms, privacy notice, `/cookies`, `/legal/merchant-terms` and `/legal/data-protection`. Every route carried draft status and noindex/nofollow. See [the counsel memorandum and completion schedules](legal-review-handoff.md) for the detailed source comparison, proposed retention periods, order form and decisions L01–L12. The draft text lives in the individual `*-draft.ts` files under `apps/web/src/content/public/`, re-exported by `legal-drafts.ts`.

The owner first reported on 2026-09-23 that legally reviewed text existed elsewhere, then reviewed this exact package locally, reported approval and instructed publication. The authorization, scope and limits of that approval are recorded in [legal-publication-approval.md](legal-publication-approval.md).

## Confirmed operator information

- Owner-provided image identifies **Awoof Digital Services**, **RC 8449678**, registered **30 April 2025**. The owner separately supplied **2 Olaide Tomori Street, Ikeja, Lagos** as the address and confirmed **support@awoof.tech** as the monitored privacy/legal request channel on 2026-09-23. The image did not show the address or contact channel; these are owner-supplied, not independently checked corporate-record details.

## Source-backed product statements

| Draft statement | Source to recheck before publication |
| --- | --- |
| Student profile can include name, email, institution and registration number; password sign-up stores a hash | `apps/backend/src/services/auth/student-signup.service.ts`; migration `001_initial_schema.sql` |
| Account login, school-account control and enrollment evidence are separate | `apps/backend/src/services/verification/student-assurance.service.ts`; `eligibility-read.service.ts`; `docs/superpowers/specs/2026-09-20-student-email-first-auth.md` |
| Merchant exchange returns scoped pseudonym and eligibility metadata, not the student's email | `apps/backend/src/services/verification/merchant-assertion.service.ts` |
| Processing and merchant grants can be withdrawn, but old receipts remain historical | `apps/backend/src/services/verification/eligibility-consent.service.ts`; merchant assertion receipt handling |
| Expired challenge payloads are scrubbed; Microsoft diagnostics older than 30 days are deleted | `apps/backend/src/services/verification/challenge-retention.service.ts`; `microsoft-retention.service.ts` |
| Session data can be in browser local storage; short-lived callback cookies serve provider redirects | `apps/web/src/lib/auth.ts`; `api-client.ts`; provider callback routes |
| Marketplace checkout can start a Paystack payment; some deals use merchant-hosted checkout | `apps/backend/src/controllers/checkout.controller.ts`; marketplace product/checkout handlers |

These are code facts on this branch, **not deployment or operating-policy evidence**. Recheck production configuration and the exact release before turning drafts into live commitments.

## External research used for information architecture only

- [Nigeria Data Protection Act 2023, section 27](https://ndpc.gov.ng/wp-content/uploads/2024/03/Nigeria_Data_Protection_Act_2023.pdf): a privacy notice identifies the controller and its means of communication, purposes/lawful bases, recipients, data-subject rights, retention, complaint route and applicable automated decisions.
- [Nigeria Data Protection Act 2023, section 31](https://ndpc.gov.ng/wp-content/uploads/2024/03/Nigeria_Data_Protection_Act_2023.pdf) and the [NDPC 2024 annual report](https://ndpc.gov.ng/wp-content/uploads/2025/01/NDPC-Annual-Report-2024.pdf): parental/guardian consent and appropriate age/consent verification need assessment when relying on consent for a child; NDPC explains that the Child Rights Act definition is under 18. Government-approved ID is a possible mechanism, not a universal NIN/BVN collection requirement.
- [NDPC cross-border transfer FAQ](https://ndpc.gov.ng/faqs/): the Act allows transfers outside Nigeria subject to its safeguards; it is not a blanket Nigeria-only storage rule.
- [UNiDAYS identity privacy policy](https://www.myunidays.com/US/en-US/content/identity-privacy-policy): separates verification-specific processing from broader marketplace processing.
- [Student Beans privacy notice](https://www.studentbeans.com/en-us/us/accounts/info/privacy): organizes data categories, sources, disclosures, choices and retention by category.
- [SheerID privacy overview](https://www.sheerid.com/privacy-overview/): plain-language explanation links to a full policy.

The drafts do **not** copy competitor terms, retention periods, security certifications or geographic claims.

## Publication gates and owner decisions

1. Confirm the contracting proprietor/entity and registration designation from the CAC certificate; the supplied image says business name and does not establish an incorporated limited company. Confirm the owner-supplied address and privacy/legal channel against records. `/contact` has already been updated locally with the confirmed inbox; verify the release before promoting it site-wide.
2. Inventory all data categories and recipients in the live release, including Microsoft/Google, universities, email delivery, hosting, payments, analytics, support and merchants. Verify cross-border transfers and contracts before describing safeguards.
3. Map each purpose to the specific lawful basis, including school/account sign-in, enrollment evidence, merchant checks, payments, fraud/security records and marketing if any. Confirm whether the current consent capture matches those bases and whether any decision requires an automated-decision notice. The candidate deliberately does not claim that every activity relies on consent.
4. Approve a full retention and deletion schedule: account data, linked identities, consent/evidence, receipts, payments, support, backups, logs and legal holds. The existing challenge/diagnostic cleanup is only a small part of this schedule.
5. Decide whether under-18 students may use Awoof and design an appropriate age/parental-consent process before claiming or enforcing a particular age rule. The current sign-up flow has no confirmed age gate. Do not start collecting NIN or BVN just for this decision without necessity, proportionality, provider/legal review and a secure data-flow design.
6. Review student and merchant Terms: acceptance point, eligibility criteria, suspension/review handling, offer/payment/refund allocation, changes, governing law and disputes. Confirm that the proposed support and material-change notice commitments can be met. Do not invent liability limits or rights waivers.
7. Owner and legal sign off on effective dates and this exact versioned text. Only then remove draft banners/noindex, add footer and sitemap links, update signup notices and Azure Branding & properties Terms/Privacy URLs, and verify the live pages and consent screen.

## Tests and release boundary

- Focused browser test: `apps/web/tests/browser/public-legal-drafts.spec.ts` checks the published routes, H1, version label, operator identity, `index, follow` metadata, sitemap/footer destinations and the merchant execution boundary.
- The sitemap allowlist includes the six published legal routes.
- Publication adds footer/auth-navigation links for the legal routes; no Azure setting, production site configuration, or deployed service was changed by the review branch itself — live publication still requires PR checks, merge, deploy success and HTTP/content checks.
