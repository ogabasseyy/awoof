# Academic-profile safeguards — Independent research and design note

**Date:** 2026-10-18  
**Author:** Codex Safeguards Engineering  
**Scope:** Privacy, retention, deletion semantics, restore-safe reconciliation, backup lifecycle, and NUC licensing for Awoof's optional academic-profile completion feature.  
**Repository:** `/Users/mac/Downloads/Awoof/.worktrees/academic-profile-safeguards` (`ogabasseyy/awoof`)  
**Status:** Research and design note; proposals pending owner/legal approval. Production collection remains **disabled** (`ACADEMIC_PROFILE_ENABLED=false`).

---

## 1. Primary sources and verified evidence

| Reference ID | Source Title | Official URL / Citation | Relevant Section / Page | Evidence Classification |
|---|---|---|---|---|
| **L01** | Nigeria Data Protection Act (NDPA) 2023 | https://ndpc.gov.ng/ | Part V (Principles), Part VI (Lawful Basis), Part VII (Rights of Data Subjects) §§ 24, 25, 34, 35, 37 | Binding statutory law in Nigeria |
| **L02** | NDPC General Application and Implementation Directive (GAID) 2025 | https://ndpc.gov.ng/ | Directives on Data Retention, Erasure Protocols, and Consent Standards | Binding regulatory directive under NDPA § 6(c) |
| **T01** | PostgreSQL 16 Documentation: Explicit Locking & Advisory Locks | https://www.postgresql.org/docs/16/explicit-locking.html | § 13.3.5 "Advisory Locks", § 9.27 "System Administration Functions" | Technical authority matching deployed DBMS |
| **T02** | PostgreSQL 16 Documentation: Backup and Restore | https://www.postgresql.org/docs/16/backup.html | § 26.1 "SQL Dump", § 26.2 "File System Level Backup" | Technical authority matching deployed DBMS |
| **C01** | UK ICO Right to Erasure Guidance | https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/individual-rights/right-to-erasure/ | "How do we delete personal data from backup systems?" | Comparative engineering guidance (not Nigerian law) |
| **N01** | NUC Core Curriculum and Minimum Academic Standards (CCMAS) | https://www.nuc.edu.ng/ccmas/ | Live NUC curriculum portal; 17 discipline standards | Official statutory regulator curriculum publications |
| **N02** | NUC CCMAS Arts (2023) | https://www.nuc.edu.ng/wp-content/uploads/2026/03/Arts-CCMAS-2023-FINAL.pdf | Copyright page: "Creative Commons Attribution-ShareAlike 3.0 IGO (CC BY-SA 3.0 IGO)" | Primary licensing statement on NUC published standard |
| **N03** | Creative Commons CC BY-SA 3.0 IGO Legal Code | https://creativecommons.org/licenses/by-sa/3.0/igo/legalcode | Section 3 (License Grant), Section 4 (Restrictions) | Binding public copyright licence terms |
| **A01** | Awoof Deployed Hostinger VPS & Docker Infrastructure | Hostinger VPS `82.29.190.219`, `docker-compose.hostinger.yml`, `scripts/backup-awoof-postgres.sh` | Container `awoof-postgres` (Postgres 16-alpine), `db_data` volume, `./backups` | Verified repository deployment configuration |

---

## 2. Verified current implementation vs. Requirements

### 2.1 Academic profile store & boundaries (PR #67 baseline)
- **Table:** `student_academic_profiles` (migration `085`). Stores `(user_id, student_id, canonical_institution_id, observed_identity_version, revision, claimed_*, programme_*, entry_*, expected_graduation_*, estimate_basis_*, estimate_stale, created_at, updated_at)`.
- **Collection flag:** `ACADEMIC_PROFILE_ENABLED=false` by default in `apps/backend/src/config/env.ts`. When `false`, all writes (`PUT`), catalogue searches (`GET /institutions`, `GET /programmes`), and estimate computations (`POST /estimate`) return `403 Forbidden`. Authenticated `GET` self-read returns `featureEnabled: false` and `promptDecision: 'continue'`.
- **Verification separation:** Academic data is strictly segregated from student assurance, email verification, and merchant eligibility receipts (`MerchantVerificationReceipt` allowlist contains zero academic fields).
- **Reference artifact:** `apps/backend/src/data/academic-programmes/nuc-v2.normalized.json` accounts for all 237 NUC Register IDs with `calculationsEnabled: false` and every row blocked.

### 2.2 Existing gaps identified by this review
1. **No Profile-Only Erasure API:** The current API only allows reading and updating (`GET`/`PUT /api/students/academic-profile`). There is no endpoint (`DELETE`) or controller method for a student to erase their optional academic profile while keeping their account active.
2. **Missing Generation Semantics:** Migration `085` has an integer `revision` (for optimistic concurrency), but no server-generated monotonic/UUID generation token. If a restored database rolls back revisions, or an account recreates a profile, revisions can collide or rewind.
3. **No Durable Deletion Ledger:** Deletions from `purgeSoftDeletedAcademicProfiles` simply delete rows with `DELETE FROM student_academic_profiles WHERE user_id IN (...)`. There is no deletion ledger, no recording of deletion intent, and no mechanism to reconcile restored backups against post-backup deletions.
4. **Purge Script Limitations:** `apps/backend/src/services/academic-profile/academic-profile-retention.service.ts` lacks:
   - Explicit `--dry-run` vs `--apply` distinction (it only deletes).
   - Database-level concurrency protection (no advisory locks to prevent overlapping cron runs).
   - Bounded batch limits (executes a single unbounded `DELETE IN (...)`).
5. **Backup Lifecycle Weaknesses:** `scripts/backup-awoof-postgres.sh` rotates solely by file count (`AWOOF_BACKUP_MAX_FILES=7`), checks only archive readability (`pg_restore --list`), creates no tamper-evident manifest, implements no time-based retention, and has no conflict protection against expiring all backups.

---

## 3. Binding requirements vs. Engineering guidance

### 3.1 Nigerian Law: NDPA 2023 & NDPC Directives (Binding)
1. **Data Minimization & Storage Limitation (NDPA § 24(1)(d), (e)):** Personal data must be adequate, relevant, limited to what is necessary, and not retained longer than necessary to achieve the stated purpose.
2. **Lawful Basis (NDPA § 25):** 
   - Awoof's optional academic profile is **not** required for student account registration or email-based discount eligibility.
   - Therefore, the lawful basis for collecting optional academic answers (programme, entry year, route) is **Consent** (NDPA § 25(1)(a)) or **Performance of a Contract requested by the data subject** (NDPA § 25(1)(b) to generate an advisory graduation calculation for the student's personal review).
   - Under NDPA § 35, where processing is based on consent, the data subject has the absolute right to **withdraw consent at any time without detriment**. Withdrawal must be as easy as giving consent. This mandates an accessible **profile-only erasure** capability.
3. **Right to Erasure (NDPA § 34(1)(d)):** Data subjects have the right to obtain erasure without undue delay when the data is no longer necessary or consent is withdrawn.
4. **Backup Erasure & Proportionality (NDPC GAID 2025):** 
   - Nigerian law does not mandate instant physical destruction of cold magnetic or block storage on every individual erasure request.
   - GAID 2025 recognizes that immediate targeted editing of read-only archival backups (`pg_dump` archives) is technically infeasible and risks data corruption.
   - Binding requirement: personal data must be erased from **live operational systems without undue delay** (target: immediate on user request; ≤30 days after account closure), and **restoration procedures must ensure erased data is not reintroduced to active processing upon disaster recovery**.

### 3.2 Comparative Guidance: UK ICO (Engineering Guidance Only)
- The UK ICO guidance on Right to Erasure states:
  *"If a valid erasure request is received, personal data should be put beyond use in backup systems until it is overwritten according to an established retention schedule."*
  *"You must ensure that if a backup is restored, the erasure requests are reapplied before the system is brought back online."*
- While UK GDPR is not Nigerian law, this provides the recognized industry engineering standard for reconciliation upon backup restoration.

### 3.3 PostgreSQL 16 Locking Semantics (Technical Authority)
- Under PostgreSQL 16:
  - `pg_try_advisory_lock(key)` acquires a session-level advisory lock. If another session holds it, it returns `false` immediately without blocking.
  - **CRITICAL POOL HAZARD:** Session-level advisory locks survive transaction commit/rollback and remain tied to the database client connection. If a connection is returned to a connection pool (like `pg.Pool`) with an advisory lock held, other queries using that connection inherit the lock, causing silent deadlocks or lock corruption.
  - **Rule:** Session advisory locks must be acquired on a **dedicated, single-use client connection** (`pool.connect()`), and **always unlocked in a `finally` block** before calling `client.release()`.

---

## 4. Proposed policy vs. Approved policy

| Policy Parameter | Proposed Policy (This Engineering Safeguard) | Approved Policy Status |
|---|---|---|
| **Soft-deleted account purge window** | 30 days after `users.deleted_at` | **PROPOSED** — Pending recorded owner/legal sign-off. `ACADEMIC_PROFILE_RETENTION_DAYS` remains unset by default in code. |
| **Active account retention** | Kept while actively enrolled + 1 year grace period after expected graduation year; periodic prompt to confirm accuracy | **PROPOSED** — Pending legal/product owner approval. |
| **Profile-only erasure** | Immediate erasure of academic answers on student request; zero delay | **PROPOSED** — Implementation-ready; collection remains disabled. |
| **Backup dump expiry** | 30 days rolling expiry from backup creation timestamp; minimum 1 valid backup retained | **PROPOSED** — Pending owner review. Replaces 7-file count rotation. |
| **Combined deletion timeline** | Up to 60 days (30 days live deletion + up to 30 days backup retention before dump overwrite) | **PROPOSED** — Accurate public disclosure text prepared in draft. |
| **NUC Reference clearance** | Calculations remain disabled (`calculationsEnabled: false`); all 237 rows blocked | **APPROVED & ENFORCED** — Clearances pending official NUC license verification. |

---

## 5. Alternatives, trade-offs and selected approach

### 5.1 Architecture: Deletion Ledger and Backup Reconciliation
- **Alternative 1: In-database ledger table only.**
  - *Flaw:* When a database is restored from a backup made on Day 10, the restored database reverts to Day 10. Any ledger entries created on Days 11–29 are destroyed with the restore! The restored system would have zero knowledge of post-backup erasures.
- **Alternative 2: Heavy external database / distributed message bus (e.g. Kafka / remote microservice).**
  - *Flaw:* Severe operational overkill for Awoof's single-VPS Hostinger architecture; introduces network latency, external dependencies, high recurring cost, and new points of failure.
- **Selected Approach (Alternative 3: Dual-Write Ledger — DB Table + Host Append-Only JSONL):**
  - Deletions are recorded in a PostgreSQL table (`academic_profile_deletion_ledger`) inside the transaction AND atomically appended to a durable host file outside the PostgreSQL volume (`backups/academic-profile-deletion-ledger.jsonl`).
  - The ledger contains only minimal, privacy-safe metadata: `userId` (UUID), `generationId` (UUID), `scope` (`profile_only` | `account_closure`), `erasedAt` (timestamp). Zero academic answers, emails, names, or cleartext PII are logged.
  - Upon restore, a dedicated reconciliation script (`scripts/reconcile-restored-academic-profiles.ts`) reads the host ledger, identifies all erasures occurring after the backup's `created_at` timestamp, and purges matching stale rows from the quarantined database before traffic is unblocked.

### 5.2 Re-creation vs. Restore Safety: Generation Semantics
- If a user erases their profile on Day 15, and on Day 20 legitimately returns to `/student/profile/complete` and saves new details, how do we distinguish their legitimate new profile from a stale profile restored from an old Day 10 backup?
- **Solution:** Every profile has an opaque server-generated `generation_id UUID`.
  - When erased, the ledger logs `(userId, generationId)`.
  - When recreated, a new `generation_id` is generated.
  - During restore reconciliation: if the restored row has `generation_id == ledger.generationId`, it is deleted. If the restored row has a different `generation_id`, it is recognized as a legitimate new generation and preserved!

---

## 6. Corrections to the handoff prompt and unresolved decisions

1. **Clarification on "Statutory 30-Day Deadlines":** The handoff prompt references 30-day timelines. NDPA 2023 does not prescribe an inflexible 30-day statutory countdown for internal soft-delete purging; rather, it requires processing "without undue delay" and in line with documented retention schedules. The 30-day window is a sound, defensible commercial engineering proposal, but must not be cited as a rigid statutory mandate.
2. **Advisory Lock Connection Handling:** The handoff correctly notes that advisory locks must be released on the same connection. In Node.js `pg`, `pool.query('SELECT pg_try_advisory_lock(...)')` borrows an arbitrary connection from the pool and releases it immediately, leaving the lock dangling on an unknown connection! Our implementation enforces `const client = await pool.connect()` and locks/unlocks exclusively on `client`.
3. **Unresolved Decisions (Must remain activation blockers):**
   - Formal owner approval of `ACADEMIC_PROFILE_RETENTION_DAYS=30`.
   - Formal owner approval of backup expiry schedule (`AWOOF_BACKUP_RETENTION_DAYS=30`).
   - Legal approval of the unpublished Privacy and Cookie amendments.
   - Written NUC copyright permission/clearance for the CCMAS curriculum dataset.
