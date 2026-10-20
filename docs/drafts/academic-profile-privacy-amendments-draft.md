# Privacy Policy Amendments: Optional Academic Profile (drafting record for v1.2)

> **IMPORTANT NOTICE:**
> **Status:** PUBLISHED as Privacy Policy version 1.2 (effective 19 October 2026) following owner approval of the 30-day retention window and scheduled purge/expiry. This document remains the drafting record for that publication.
> **Legal Notice:** The amendments below were approved by the business owner for publication; they were not separately approved by external legal counsel. The published text is maintained in `apps/web/src/content/public/privacy-draft.ts`.
> **Effective Policy:** The effective public Privacy Notice is version 1.2 at `/privacy`, with archived version 1.1 at `/privacy/v1-1` and version 1.0 at `/privacy/v1-0`.

---

## 1. Context of proposed amendment
This draft documents the prospective privacy disclosure required before activating the optional academic-profile completion feature (`ACADEMIC_PROFILE_ENABLED=true`). In accordance with the Nigeria Data Protection Act (NDPA) 2023 and NDPC General Application and Implementation Directive (GAID) 2025, this text specifies the personal data elements, purposes, lawful bases, recipients, rights, and retention schedules specific to academic profile data.

---

## 2. Proposed additions to "What personal information we collect"

### Proposed Subsection: Optional academic profile details
When an authenticated student chooses to complete their optional academic profile, we collect:
- **Institution selection:** Your institution name and country code (either selected from the approved catalogue or self-reported as a claimed institution name and country).
- **Academic programme:** Your course or programme of study (selected from the national programme reference or entered as a custom course title).
- **Entry year and route:** The calendar year you entered your programme and your admission pathway (Unified Tertiary Matriculation Examination [UTME/100-level], Direct Entry 200-level, Direct Entry 300-level, or Transfer/Other).
- **Graduation year and estimate:** Your expected graduation year, which may be suggested based on reviewed standard programme durations or self-reported by you, and whether you confirmed or adjusted that estimate.
- **Form choices:** Explicit indications if you choose "Not sure" or "Skip this detail" for any optional question, which are recorded to prevent repeated prompts.

**What we do NOT collect in this form:**
We do not collect academic transcripts, grades, grade point averages (GPA), class of degree, disciplinary records, tuition fee receipts, or government identity numbers (NIN, BVN) through this profile screen.

---

## 3. Proposed additions to "Why we use information and our legal grounds"

### Proposed Purpose & Lawful Basis
- **Purpose:** Displaying your academic details on your personal student profile hub and calculating an advisory estimated graduation year for your convenience and personal planning.
- **Lawful Basis (NDPA 2023 § 25(1)(a) & § 25(1)(b)):**
  - **Consent / Performance of a requested service:** Providing this information is entirely voluntary. You provide these details voluntarily to receive an automated graduation estimate and personalize your account view.
  - **Withdrawal of Consent:** Under NDPA § 35, you have the right to withdraw your consent at any time without penalty or detriment. Withdrawing consent or erasing your academic profile does not affect your student discount eligibility, active verified student status, or general account access.

### Strict purpose limitation and prohibitions
- **No eligibility gating:** Optional academic details are **never** used to determine, grant, extend, restrict, or revoke student discount eligibility. An empty, partial, skipped, or erased academic profile has zero negative impact on your ability to verify enrollment or redeem discounts.
- **Advisory estimates only:** A calculated graduation year is an automated advisory estimate based on standard curriculum lengths. It is **not** institutional proof of current active enrollment, and is never represented as an authoritative academic certificate.
- **No merchant disclosure:** Merchants and partner vendors **never** receive your course, entry year, admission route, or graduation year in standard discount verification responses or merchant receipts. Merchant receipts never include academic-profile fields; the full receipt contents are described in the published notice's "What merchants receive" section.
- **No automated behavioral marketing:** Academic fields are not used to build advertising profiles, credit scores, or sell to third-party data brokers.

---

## 4. Proposed additions to "Your rights: Profile-only erasure and correction"

### Right to rectification (NDPA § 34(1)(c))
You can review, edit, or update your course, entry year, admission route, or expected graduation year at any time by navigating to `/student/profile/complete`. Updating your details immediately recalculates your advisory estimate.

### Right to profile-only erasure (NDPA § 34(1)(d))
You have the explicit right to erase your optional academic profile without closing your Awoof account.
- You can submit an erasure request directly through your student profile settings or by contacting `support@awoof.tech`.
- Profile-only erasure deletes your institution claim, programme selection, entry year, admission route, graduation estimate, and calculation basis from active database systems immediately upon confirmation.
- Following erasure, your account remains fully active, your student verification and discount eligibility remain unchanged, and your academic profile resets to an uncompleted state.

---

## 5. Proposed additions to "How long information is kept (Retention & Disposal)"

### Retention during active account lifecycle
- Academic profile answers are retained while your account remains active and you continue your studies. If you complete or leave your programme, or if your expected graduation year has passed by more than one calendar year, Awoof may invite you to confirm the continued relevance of your data or automatically schedule the optional details for retirement.

### Account closure and soft-deletion
- **Status:** The 30-day retention window was owner-approved and the automated purge and backup-expiry schedules were enabled on 2026-10-19. Account closure itself is not yet implemented in the application, so the soft-deletion trigger below takes effect when that lifecycle ships; profile-only erasure (section 4) is available now.
- If you request account closure or delete your account, your account is soft-deleted. Academic profile records are retained for a grace period of **30 days** following account closure to allow for accidental deletion recovery.
- Upon the expiration of the 30-day retention window, an automated background purge permanently erases the academic profile row from live production databases.

### Backup archives and final disposal
- Production database backups are created for business continuity and disaster recovery.
- Backups are maintained in access-restricted storage (filesystem permissions only; no backup encryption is currently implemented) and expire on a rolling **30-day** schedule under the enabled expiry job. If no backup remains within that window, the newest verified backup may be retained longer solely as a last-resort recovery copy. A backup that cannot be verified against its integrity manifest is never restored, stays access-restricted, and is removed through backup maintenance review, so it can also persist beyond 30 days until removed.
- **Total Combined Timeline:** Personal academic data normally persists in backup dumps for up to 30 days after deletion from live systems (up to **60 days total** following account closure), subject to that last-resort exception.
- If a database restore drill or disaster recovery occurs, our restore-safe reconciliation system automatically reapplies post-backup erasures before production traffic is re-established, ensuring that erased records are not resurrected.
