# Academic-Profile Retention Policy, State Transitions & Deletion Semantics

**Date:** 2026-10-18  
**Scope:** Lifecycle, retention, deletion semantics, and disaster-recovery reconciliation for student academic profile data in Awoof.  
**Classification:** Internal operational policy & state-machine specification.

---

## 1. Inventory of Academic Data and Derivatives

Every location where academic-profile personal data or its derivatives exist must be accounted for and covered by erasure procedures:

| Store / Component | Technology | Exact Fields Present | Retention & Disposal Mechanism |
|---|---|---|---|
| **Primary Store** | PostgreSQL 16 table `student_academic_profiles` | `user_id`, `student_id`, `canonical_institution_id`, `claimed_institution_name`, `claimed_institution_country`, `programme_id`, `course_label`, `entry_year`, `entry_route`, `expected_graduation_year`, `graduation_year_origin`, `estimate_basis_*`, `generation_id`, `revision` | Hard physical deletion via `DELETE` (triggered by soft-delete purge or profile-only erasure API). |
| **Deletion Ledger (DB)** | PostgreSQL 16 table `academic_profile_deletion_ledger` | `id`, `user_id`, `generation_id`, `scope`, `erased_at`, `reconciled_at` (NO answers, NO names, NO emails) | Retained as append-only reconciliation log exceeding backup lifespans. (90-day disposal policy is planned for future implementation upon authorization). |
| **Durable Ledger (Host)** | Append-only JSONL file on VPS host filesystem (`backups/academic-profile-deletion-ledger.jsonl`) | `userId`, `generationId`, `scope`, `erasedAt` | Appended atomically during erasure; preserved independently of PostgreSQL dumps. (90-day disposal is not yet implemented; ledger remains append-only). |
| **In-Memory Projections** | Node.js backend runtime | Transient `AcademicProfileProjection` objects | Cleared on request completion; garbage collected by V8 engine. |
| **Client Local Storage** | Browser `localStorage` | `awoof.profile.defer-prompt.v1.<browserSessionId>` containing only `userId` | Evicted on logout, session switch, or explicit browser cache clearance. |
| **Operational Logs** | Winston / stdout logs | Counts-only metrics (`deletedProfiles=N`, `outcome=success`) | Zero personal data or identifiers emitted to logs. |
| **Backup Dumps** | PostgreSQL custom-format dumps (`awoof-*.dump`) | Complete snapshot of `student_academic_profiles` table at dump time | Expired and unlinked after 30 days by `expire-awoof-backups`. On restore, purged by reconciliation before traffic release. |

---

## 2. Deletion State-Transition Table

```
                  ┌────────────────────────────────────────────────────────┐
                  │                    Active Account                      │
                  │              (No academic profile row)                 │
                  └───────────────────────────┬────────────────────────────┘
                                              │ Student voluntarily saves
                                              │ (New generation_id generated)
                                              ▼
                  ┌────────────────────────────────────────────────────────┐
                  │                 Academic Profile Saved                 │
                  │              (Active student, generation A)            │
                  └──────┬────────────────────┬────────────────────┬───────┘
                         │                    │                    │
   Profile-only erasure  │                    │ Update answers     │ Account closed
   (Student API call)    │                    │ (Revision bumps)   │ (users.deleted_at set)
                         ▼                    ▼                    ▼
┌───────────────────────────────┐ ┌──────────────────────┐ ┌───────────────────────────┐
│     Profile-Only Erased       │ │ Profile Updated      │ │     Soft-Deleted Account  │
│ (Row deleted, ledger logged,  │ │ (New answers saved,  │ │ (Row kept during the      │
│  profile resets unanswered)   │ │  revision + 1)       │ │  retention window)        │
└───────────────┬───────────────┘ └──────────────────────┘ └─────────────┬─────────────┘
                │                                                        │
                │ Legitimate voluntary                                   │ Retention cutoff reached
                │ recreation                                             │ (Purge job executes)
                ▼                                                        ▼
┌───────────────────────────────┐                          ┌───────────────────────────┐
│     Profile Recreated         │                          │      Permanently Purged   │
│ (New generation B generated,  │                          │ (Row deleted, ledger      │
│  distinct from generation A)  │                          │  logged, DB clock checked)│
└───────────────────────────────┘                          └───────────────────────────┘
```

### Transition Specifications

| Transition | Authorization Required | Trigger Event | Affected Data | Target SLA | Retry & Failure Policy | Completion Evidence |
|---|---|---|---|---|---|---|
| **T1: Profile-only erasure** | Authenticated Student (session `userId`) | `DELETE /api/students/academic-profile` | Row in `student_academic_profiles` for user | Immediate (< 1 second) | Transactional rollback on error; client retries with backoff | DB row deleted; ledger record inserted; durable host ledger appended; response `200 { erased: true }` |
| **T2: Profile correction / update** | Authenticated Student (session `userId`) | `PUT /api/students/academic-profile` | Fields in `student_academic_profiles` | Immediate (< 1 second) | Optimistic concurrency check (`expectedRevision`); 409 Conflict on revision drift | `revision` incremented; `updated_at` refreshed from DB clock; recalculated projection returned |
| **T3: Account closure (Soft delete)** | Authenticated User or Admin | Account closure / deletion workflow | `users.deleted_at` timestamp set | Immediate | Database update transaction | `users.deleted_at IS NOT NULL`; academic profile inaccessible via API |
| **T4: Account restoration (within the retention window)** | Authenticated User / Admin | Account recovery before the retention cutoff | `users.deleted_at` cleared to NULL | Immediate | Transactional clear | `users.deleted_at IS NULL`; existing academic profile restored without data loss |
| **T5: Retention purge (post-closure)** | System Scheduler / CLI operator | Scheduled daily purge job (`cleanup-academic-profile-data`) | All `student_academic_profiles` where account `deleted_at <= now - ACADEMIC_PROFILE_RETENTION_DAYS` (approved value; the runtime has no default) | Next scheduled run after the retention cutoff | Advisory lock prevents overlap; bounded batches; retried on next schedule run | Sanitized counts logged; rows removed; ledger records written; DB clock cutoff verified |
| **T6: Legitimate profile recreation** | Authenticated Student (session `userId`) | Voluntary navigation to `/student/profile/complete` and save | New row in `student_academic_profiles` with fresh `generation_id` | Immediate | Standard save concurrency | New `generation_id != old_generation_id`; revision starts at 1 |
| **T7: Backup restoration & quarantine** | Disaster Recovery Operator | Restoring `awoof-*.dump` following system outage or test drill | Entire database snapshot | Prior to releasing traffic | Fail-closed: application must not start until reconciliation succeeds — enforced in backend startup, which runs reconciliation before listening whenever the durable ledger exists on the host and aborts startup on failure (the CLI remains available for quarantined manual runs) | `reconcile-restored-academic-profiles` output; startup reconciliation log line; stale restored rows purged; recreated generations preserved |

---

## 3. Server-Generated Generation Semantics

To prevent restored backups from resurrecting erased personal data without accidentally destroying legitimate newly created profiles:
1. Every academic profile has a server-generated `generation_id UUID NOT NULL DEFAULT gen_random_uuid()`.
2. When a profile is erased (either by user request or post-closure purge), the deletion ledger records `(user_id, generation_id, scope, erased_at)`.
3. If the user later legitimately recreates their profile, a new UUID is generated for `generation_id`.
4. When a backup dump created at time $T_{backup}$ is restored at $T_{restore}$:
   - Any profile with $T_{erased} \ge T_{backup}$ was erased *after* the backup was made.
   - The reconciliation tool compares the `generation_id` in the restored database with the `generation_id` recorded in the durable deletion ledger.
   - **Match (`db.generation_id == ledger.generation_id`):** The row is stale data resurrected from the backup. It is immediately deleted.
   - **Mismatch (`db.generation_id != ledger.generation_id`):** The user legitimately created a new profile after the erasure. The new profile is **preserved**.

---

## 4. Active-Account Retention and Continuing Necessity

**Status: PLANNED — not implemented.** No backend job, service, or UI currently performs the reconfirmation or retirement described in this section; active-account academic profiles persist until this control is implemented and approved. Nothing in this section is an operational control today.

Under NDPA 2023 § 24(1)(e), the existence of an active account alone does not justify the indefinite retention of personal data.
1. **Continuing Necessity Rule:** Academic profile answers (programme, admission route, entry year, expected graduation year) remain necessary only while the student is actively enrolled or in their graduation transition.
2. **Scheduled Review & Retirement (proposed, gated on implementation and owner approval):**
   - Once a student's `expected_graduation_year` has passed by **more than 1 calendar year** (e.g. current year $\ge$ expected graduation year + 2), the data is deemed past its primary advisory necessity.
   - The platform will either present a reconfirmation prompt ("Are you still enrolled in this programme?") or schedule the optional fields for retirement, returning the profile to an uncompleted state without affecting account login or general discount access.

---

## 5. Dual Deletion Timelines (Live vs. Backup)

Public statements must never promise immediate physical eradication across all disaster-recovery media. The timeline consists of two independent phases:
No academic-profile retention duration is approved yet: `ACADEMIC_PROFILE_RETENTION_DAYS` has no default and the purge fails closed until an authorized value is configured. Durations below that mention a number of days for the academic-profile window are the pending proposal used as an example, not an active policy commitment.
1. **Phase 1: Live System Deletion (0 to the approved retention window):**
   - Profile-only erasure: **Immediate** (real-time transaction).
   - Account closure: grace retention window of the approved `ACADEMIC_PROFILE_RETENTION_DAYS` (30 days in the pending proposal), followed by daily scheduled purge.
2. **Phase 2: Backup Expiry (up to the configured backup retention):**
   - Database backups are rotated on a rolling schedule (`AWOOF_BACKUP_RETENTION_DAYS`, default 30 days in `expire-awoof-backups`). The expiry `--apply` job is **not scheduled yet**: `scripts/scheduler/awoof-backup-expiry.cron` is a disabled template, so until the owner activates it, backups can outlive the 30-day window (deploy-time count rotation in `backup-awoof-postgres.sh` is the only live expiry).
   - A backup created on the last day of its rotation containing an active account expires one rotation later.
3. **Total Maximum Retention Window:** The approved academic-profile window plus the configured backup rotation (60 days only in the example where both are 30 days); no total is committed until the academic-profile value is approved.

---

## 6. Specific Preservation Exceptions (Legal Holds)

1. **No Blanket Holds:** A general commercial dispute or customer inquiry never constitutes a blanket legal hold over optional academic answers.
2. **Qualifying Grounds:** An exception to automated academic profile erasure applies **only** if:
   - Formally served with a valid court order, subpoena, or written regulatory notice under NDPA § 34(2); or
   - An active formal legal dispute specifically involves the veracity of the academic profile data.
3. **Segregation & Access:** Data subject to a legal hold must be extracted to an encrypted, access-restricted compliance archive accessible only to designated legal officers, and removed from operational student tables.
