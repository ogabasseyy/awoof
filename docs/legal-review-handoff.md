# Awoof — counsel review memorandum and completion schedules

**Version:** 23 September 2026. **Status:** original drafting proposals, not effective policies or executed agreements. Prepared from source review and the primary materials linked below. This is a review package, not a legal opinion, compliance certification or confirmation of production operations.

## Reading order and document architecture

Start at local `/legal`, then `/terms`, `/privacy`, `/cookies`, `/legal/merchant-terms` and `/legal/data-protection`. The first three user documents and two partner documents are linked from the draft navigation only. They are excluded from the public footer and sitemap, have noindex/nofollow metadata and carry a visible draft notice. Noindex is not access control. Production publication requires a separate decision.

Source text lives in `apps/web/src/content/public/{privacy-draft,terms-draft,cookies-draft,merchant-legal-draft,data-protection-draft}.ts`. The draft shell displays the review version; there is no effective date. A portable consolidated reading copy is maintained at `docs/legal-review-reading-copy.md`.

The privacy notice describes information use; it does not obtain all consents. Student terms allocate service responsibilities. Merchant terms allocate commercial risk and require an order form. The data-protection schedule has separate-controller and processor modules selected by actual activity. The cookies notice explains browser storage without inventing a deployed preference centre. Existing `/trust`, `/help`, `/contact`, `/partner` and `/developers` remain the product information pages; this package does not certify their deployment claims.

## Executive assessment

The drafting includes the missing commercial protections identified in the earlier review: purpose-limited use, prohibited resale and abusive automation, intellectual property, merchant fulfilment duties, payment-role boundaries, suspension and exit, limited commercial warranties, negotiated business liability caps, causation-based indemnities, confidentiality, provider failure limits and disputes. Mandatory consumer/data rights remain reserved. A separate student indemnity, nominal liability cap, blanket no-refunds term, mandatory arbitration and imported US class-action waiver were deliberately not proposed.

The largest legal uncertainty is **who contracts**. The supplied image describes a **business name**, “Awoof Digital Services”, with number 8449678 displayed under an RC label. It does not establish a separate incorporated limited-liability company. Obtain the CAC certificate/status report and identify the proprietor(s) or incorporated operator; confirm the correct RC/BN designation. Public drafts neutrally identify the supplied registration number. Website terms cannot create corporate limited liability where it does not exist.

The second uncertainty is **Awoof's payment role**. Source supports both external merchant checkout and Awoof-initiated Paystack transactions, including split/manual settlement modes. Provider contracts and actual money flow determine collection authority, seller/payee status and settlement obligations. No disclaimer should contradict those facts.

## Research and application to these drafts

Reviewed 23 September 2026. Primary legal sources govern over competitors. Competitor documents are jurisdiction-specific structural references, not legal authority or permission to copy their wording.

| Source | Application / review question |
| --- | --- |
| [Nigeria Data Protection Act 2023](https://ndpc.gov.ng/wp-content/uploads/2024/03/Nigeria_Data_Protection_Act_2023.pdf), ss 24–29 | Assess lawful bases, transparent notices, records and impact assessment. Candidate bases must be reconciled with actual processing. |
| Same Act, ss 31, 34–40 | Resolve minors, rights requests, automated decisions, security and breach handling. An eligibility rejection may require analysis of significance rather than an assumption that every discount decision is exempt. |
| Same Act, ss 41–44 | Document transfer basis and assess registration applicability. No general “all Nigerian data must stay in Nigeria” conclusion is used. |
| [Final GAID 2025](https://ndpc.gov.ng/wp-content/uploads/2025/07/NDP-ACT-GAID-2025-MARCH-20TH.pdf) | Check applicable classification, DPO, assessment, notices and filing requirements. The earlier GAID draft is not used as operative law. Full PDF opening was intermittent during this pass; indexed official extracts support the document reference, but counsel should verify the final text directly. |
| [FCCPA](https://fccpc.gov.ng/wp-content/uploads/2022/07/FCCPA-2018.pdf), especially ss 127–129 | Review fairness and prominent disclosure of risk terms. Do not purport to remove mandatory remedies or protect gross negligence. Contract acceptance must actually present material restrictions. |
| [FMCIDE cloud-policy announcement, 17 August 2026](https://fmcide.gov.ng/federal-government-unveils-national-digital-cloud-policy-to-drive-investment-digital-sovereignty-and-government-transformation/) | Distinguish commercial processing from government/institution restrictions. Obtain the policy and institution obligations before agreeing any locality warranty; the announcement alone is not a transfer assessment. |
| [UNiDAYS terms](https://www.myunidays.com/US/en-US/terms-of-service) | Compare user/service scope, third-party offers, IP, service changes and liability. Do not import its jurisdiction-specific waivers or its account/marketing model. |
| [Student Beans privacy](https://www.studentbeans.com/en-us/us/accounts/info/privacy) and [member terms](https://www.studentbeans.com/en-ca/ca/accounts/info/terms) | Separate data categories and activities; cover expiry, misuse and third-party offers. Its age thresholds and retention periods are not adopted. |
| [Student Beans merchant terms](https://partner.studentbeans.com/terms-of-use/self-service/) | Separate business obligations from student terms; require commercial scope and risk allocation. Do not copy its pricing, service thresholds or competitive restrictions. |
| [SheerID current VSA](https://www.sheerid.com/vsa/) and [DPA](https://www.sheerid.com/dpa/) | Use an order form and processing annex. Unlike a universal processor characterization, Awoof's role is determined separately for accounts, checks, disclosures and purchases. |

## Decision register — exact items to approve

| ID | Proposed treatment | Required confirmation / owner |
| --- | --- | --- |
| L01 | Awoof Digital Services, supplied number 8449678, supplied address and support inbox | Counsel/owner: legal contracting party, proprietor(s), CAC designation and service address. |
| L02 | Contract for necessary account/transaction functions; consent for optional verification/disclosure; assessed legitimate interests for security; specific legal duties for required records | Counsel/privacy owner: activity-level map, LIA where needed, consent text and boundaries. No retrospective basis-switch to avoid withdrawal. |
| L03 | No presumed age from a school identity; no invented age gate | Owner/counsel: choose an adults-only initial registration rule with proportionate enforcement, or a minors route with validated guardian authority/consent where required. An 18+ rule would exclude some genuine university students. Neither is implemented by this work. |
| L04 | Automated eligibility logic described; request for correction/review through support | Counsel/operations: s 37 assessment, intervention owner, source-correction route, appeal record and decision safeguards. No claim that every automated result is already human-reviewed. |
| L05 | Retention criteria in draft notice, candidate periods below | Counsel/engineering: approve periods and deploy deletion/restriction jobs before stating them as practice. Current immutable identity/consent rows require a deliberate erasure strategy. |
| L06 | Recipient categories and conditional transfers | Operations/counsel: exact entities, contract roles, destinations, DPAs/transfer safeguards, public-provider list and institution restrictions. |
| L07 | Merchant is identified seller; Awoof acknowledges its payment functions and own obligations | Owner/payments counsel: contracts, acquiring terms, collection authority, payee, reconciliation, commission/refunds and whether any additional regulatory obligations arise. |
| L08 | Business cap: previous 12 months' service fees; 2x for specified confidentiality/data/indemnity risks; no implicit zero cap for free pilot | Counsel/owner: insurance, deal size, risk appetite, statutory exclusions and written free-pilot cap. Not appropriate to copy into consumer terms. |
| L09 | Narrow merchant indemnity and Awoof IP defence with procedure and causation limits | Counsel: claims allocation, cap interaction, insurable exposure, recoverability and settlement control. |
| L10 | Nigerian law; competent courts; no compulsory consumer arbitration | Counsel: exact entity, territory and any separately negotiated B2B dispute process. No blanket assertion of enforceability across Africa. |
| L11 | Support, closure, restriction-review and change-notice procedures | Operations: reachable owner, response tracking, escalation, legal-deadline calendar and account/data workflows. No invented public SLA. |
| L12 | DCPMI/DPO/DPIA/CAR assessment recorded before launch | Counsel/privacy owner: actual scale and risk classification under current NDPC instruments; obtain appropriate licensed help where needed. No registration or certification badge is claimed. |

## Product evidence and limitations

| Subject | Source evidence | Boundary for counsel |
| --- | --- | --- |
| Account identity, institution identity, enrollment | `student-assurance.service.ts`, `eligibility-read.service.ts`, `student-sso-flow.service.ts` under backend services | A configured path is not evidence of a signed school partnership or runtime activation. |
| Standard merchant response | `services/verification/merchant-assertion.service.ts`, `routes/merchant-verification.routes.ts` | Scoped identifier and result metadata. Do not extend the no-email statement to every order/seller screen or support exchange. |
| Consent withdrawal/history | `services/verification/eligibility-consent.service.ts` | Historical records remain; withdrawal is not erasure. |
| Checkout and commissions | `controllers/checkout.controller.ts`, `services/payment/checkout.service.ts` | Code shows initiation and split/manual modes; provider contract and production money flow still need verification. |
| Expired challenge secrets | `services/verification/challenge-retention.service.ts` | Scrubbing becomes eligible 24 hours after expiry, with batching/dispatcher lag; not a full personal-data deletion rule. |
| Microsoft diagnostics | `services/verification/microsoft-retention.service.ts` | 30-day configured diagnostic cutoff, not proof the job runs successfully in production. Other evidence/audit rows remain. |
| Identity/consent immutability | migrations `054_microsoft_identity_no_delete.sql`, `055_microsoft_consent_no_delete.sql` | Schema restrictions do not establish a lawful indefinite retention period; design restriction, redaction or other lawful erasure handling. |
| Browser storage | web `lib/auth.ts`; student SSO and verification completion components; backend SSO/Microsoft routes | Session and redirect storage exists. Inventory cookies on production before publishing an exhaustive list. |
| Configurable providers | backend `config/env.ts` | Microsoft, Google, email providers, Paystack and object storage configuration does not prove all are active. No secrets are needed in this pack. |

Paths above are relative to `apps/backend/src` unless marked web. Source checkout reviewed from the legal worktree based on main commit `4074987`; these local facts must be rechecked against the release intended for publication.

## Candidate retention schedule — proposed policy, not current enforcement

These are starting proposals for review, not asserted statutory minima or a copy of competitor periods. Approve or replace each and test the corresponding process. Record the justification for retaining identifiable information rather than a reduced audit record.

| Category | Candidate rule | Known gap / validation |
| --- | --- | --- |
| Active account/profile | Active relationship; after validated closure, complete deletion/redaction within 30 days except justified records below | Closure, legal exceptions and storage coverage need implementation proof. |
| Linked school identity/enrollment history | Keep while needed for active service; review after expiry/closure; propose a minimized dispute record for 12 months after last relevant decision | Immutable records/FKs need engineering design; longer fraud history needs a case-specific basis. |
| Consent/disclosure evidence | Minimized evidence for 6 years after last reliance/withdrawal, subject to counsel's limitation analysis and necessity assessment | Proposed only; distinguish consent evidence from original documents/profile data. |
| Purchases/refunds/settlement | Proposed 6 years after the relevant financial period, adjusted to the actual accounting/tax/claim obligation counsel identifies | Do not call six years the universal Nigerian statutory period. |
| Support correspondence | Proposed 24 months after resolution; extract only justified material if a continuing dispute requires longer | Needs automated expiry, attachments coverage and access review. |
| Security/fraud investigations | Routine diagnostics short-lived; proposed 24-month ceiling after a closed investigation for justified minimized evidence | A generic “fraud” label cannot suspend deletion indefinitely; review holds. |
| Challenge material | Existing source: expiry + 24-hour eligibility for scrubbing, subject to batch/job lag | Verify runtime completion and backlog monitoring before publishing a fixed deletion promise. |
| Microsoft diagnostic events | Existing source: eligible for deletion after 30 days | Verify scheduled drain and operational evidence. |
| Backups | Proposed maximum 90-day rolling expiry, restricted recovery use; reapply deletions on restore | Actual backup/storage contracts and recovery procedure not inventoried. |
| Legal holds | Specified records only; documented ground, responsible person and periodic review; release when ground ends | No blanket hold on all accounts. |

## Provider/location inventory to complete

For each active provider record: legal entity; service; controller/processor role; exact data; primary/backup regions; support-access countries; contract/DPA; onward recipients; transfer basis/assessment; retention; deletion confirmation; owner; evidence date.

Candidate inventory rows from source are hosting/database, object storage, email delivery, Microsoft school sign-in, Google school sign-in where enabled, Paystack, and any support/monitoring tools. Verify which email/storage providers are active rather than listing every environment option. No production hostnames, credentials or internal infrastructure addresses belong in public pages. Publish the approved recipient information after this inventory, not a guessed list.

## Merchant order form and payment schedule template

Complete these fields and attach the agreed versions; there is no automatic acceptance or fee configuration:

- Legal parties, registration identifiers, addresses, authorized signatories, contract notices and operational contacts.
- Service scope, supported channels/domains, eligible population/institutions, verification assurance, feature availability and activation evidence.
- Offer criteria, stock/exclusions, dates, discount calculation, redemption limits, seller identity, brand approvals and customer-support split.
- Term, start, trial end, renewal procedure, termination rights and any express exclusivity (otherwise none).
- Fees/commission, billing unit and currency, taxes, provider charges, invoicing, payment due dates and a written free-pilot liability cap where relevant.
- Checkout mode, seller/payee, collection authority, split/manual settlement, settlement timetable, reconciliation evidence, refunds, chargebacks, authorized reserve/set-off and exit balances.
- Data roles and completed processing/security/retention annex, incident contacts and transfer evidence.
- Agreed liability amendments, any insurance requirement, notice/cure provisions and authorized signatures.

An institution requires a separate binding authority/service arrangement identifying its power to supply enrollment information and any public-sector restrictions; the data schedule alone is insufficient. Start with minimized status/expiry data, not a bulk student directory. A merchant cannot authorize a university disclosure on the university's behalf.

## Acceptance and release implementation

Once approved, present the precise version before registration or contract acceptance and retain a proportionate record of assent, version and time. Draw liability/risk provisions to users' attention as required; a footer link alone is not proof of assent. Keep privacy notice acknowledgement distinct from optional consents, including merchant-specific disclosure. Preserve earlier approved versions and handle material changes prospectively.

Before removing draft status: complete decisions L01–L12; confirm deployed capabilities; implement required age, request, notice and deletion procedures; finalize exact text with counsel; record approval of that version; set its effective date; then add approved public/footer/signup/Azure links and verify them. Do not present the date of this drafting exercise as an effective date. Do not add an Azure policy URL simply because a local page resolves.

## Suggested lawyer response format

For each document: **approve / approve with redlines / not approved**, clause references, required facts and enforceability concerns. Separately return completed L01–L12 decisions, approved schedules and any jurisdiction/territory limits. Engineering should record which recommendations require code or operations changes rather than silently converting legal proposals into claims of existing behavior.
