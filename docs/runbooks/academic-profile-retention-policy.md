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
| **Deletion Ledger (DB)** | PostgreSQL 16 table `academic_profile_deletion_ledger` | `id`, `user_id`, `generation_id`, `scope`, `erased_at`, `reconciled_at`, `host_published_at` (NO answers, NO names, NO emails). `host_published_at` is the persisted outbox state: NULL until the tombstone is durably published to the host ledger, which is what the background dispatcher drains | Retained as append-only reconciliation log exceeding backup lifespans. (90-day disposal policy is planned for future implementation upon authorization). |
| **Durable Ledger (Host)** | Append-only JSONL file on VPS host filesystem (`backups/academic-profile-deletion-ledger.jsonl`) | `userId`, `generationId`, `scope`, `erasedAt` | Appended atomically during erasure; preserved independently of PostgreSQL dumps. (90-day disposal is not yet implemented; ledger remains append-only). |
| **In-Memory Projections** | Node.js backend runtime | Transient `AcademicProfileProjection` objects | Cleared on request completion; garbage collected by V8 engine. |
| **Client Local Storage** | Browser `localStorage` | `awoof.profile.defer-prompt.v1.<browserSessionId>` containing only `userId` | Evicted on logout, session switch, or explicit browser cache clearance. |
| **Operational Logs** | Winston / stdout logs | Counts-only metrics (`deletedProfiles=N`, `outcome=success`) | Zero personal data or identifiers emitted to logs. |
| **Backup Dumps** | PostgreSQL custom-format dumps (`awoof-*.dump`) | Complete snapshot of `student_academic_profiles` table at dump time | Time-based expiry after 30 days is ACTIVE since 2026-10-19: the `expire-awoof-backups --apply` job is installed on the production VPS (see Activation record below); deploy-time count rotation also applies. On restore, purged by reconciliation before traffic release. |

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
| **T1: Profile-only erasure** | Authenticated Student (session `userId`) | `DELETE /api/students/academic-profile` | Row in `student_academic_profiles` for user | Immediate (< 1 second) | Partial-commit outbox: the DB row deletion and database ledger record commit first; if the post-commit durable host append then fails, the API returns an error but the profile is already erased - the client retries DELETE (safe and idempotent) to republish the committed outbox record to the host ledger, and the retention purge republishes as a backstop | DB row deleted; ledger record inserted; durable host ledger appended; response `200 { erased: true }` |
| **T2: Profile correction / update** | Authenticated Student (session `userId`) | `PUT /api/students/academic-profile` | Fields in `student_academic_profiles` | Immediate (< 1 second) | Optimistic concurrency check (`expectedRevision`); 409 Conflict on revision drift | `revision` incremented; `updated_at` refreshed from DB clock; recalculated projection returned |
| **T3: Account closure (Soft delete)** — PLANNED, not implemented (no route or service sets `users.deleted_at` for students today, so the post-closure purge has no production lifecycle trigger yet) | Authenticated User or Admin | Account closure / deletion workflow | `users.deleted_at` timestamp set | Immediate | Database update transaction | `users.deleted_at IS NOT NULL`; academic profile inaccessible via API |
| **T4: Account restoration (within the retention window)** — PLANNED, not implemented (no workflow clears `users.deleted_at` today) | Authenticated User / Admin | Account recovery before the retention cutoff | `users.deleted_at` cleared to NULL | Immediate | Transactional clear | `users.deleted_at IS NULL`; existing academic profile restored without data loss |
| **T5: Retention purge (post-closure)** | System Scheduler / CLI operator | Scheduled daily purge job (`cleanup-academic-profile-data`) | All `student_academic_profiles` where account `deleted_at <= now - ACADEMIC_PROFILE_RETENTION_DAYS` (approved value; the runtime has no default) | Next scheduled run after the retention cutoff | Advisory lock prevents overlap; bounded batches; retried on next schedule run | Sanitized counts logged; rows removed; ledger records written; DB clock cutoff verified |
| **T6: Legitimate profile recreation** | Authenticated Student (session `userId`) | Voluntary navigation to `/student/profile/complete` and save | New row in `student_academic_profiles` with fresh `generation_id` | Immediate | Standard save concurrency | New `generation_id != old_generation_id`; revision starts at 1 |
| **T7: Backup restoration & quarantine** | Disaster Recovery Operator | Restoring `awoof-*.dump` following system outage or test drill | Entire database snapshot | Prior to releasing traffic | Fail-closed: application must not start until reconciliation succeeds — enforced in backend startup, which runs reconciliation before listening whenever the durable ledger exists on the host and aborts startup on failure (the CLI remains available for quarantined manual runs) | `reconcile-restored-academic-profiles` output; startup reconciliation log line; stale restored rows purged; recreated generations preserved |

**Rollout (first deployment of the ledger gate):** the first deploy finds a genuinely empty `backend_backups` volume, because no tombstone could exist before this code shipped. For that one deploy, set `ACADEMIC_PROFILE_FRESH_DEPLOYMENT=true` in the VPS `.env` (wired through `docker-compose.hostinger.yml`); startup writes `.academic-profile-ledger-initialized` into the volume and later restarts no longer need the flag. Remove the flag from `.env` after the first healthy deploy — leaving it set would let an emptied volume masquerade as a fresh deployment. Never set it on a host that has ever recorded an erasure unless the ledger volume is intact.


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
The owner approved a 30-day academic-profile retention window on 2026-10-19: `ACADEMIC_PROFILE_RETENTION_DAYS=30` is configured in production and the purge fails closed if an authorized value is ever removed. Durations below are the active policy.
1. **Phase 1: Live System Deletion (0 to the approved retention window):**
   - Profile-only erasure: **Immediate** (real-time transaction).
   - Account closure: grace retention window of the approved `ACADEMIC_PROFILE_RETENTION_DAYS` (30 days), followed by daily scheduled purge.
2. **Phase 2: Backup Expiry (up to the configured backup retention):**
   - Database backups are rotated on a rolling schedule (`AWOOF_BACKUP_RETENTION_DAYS`, default 30 days in `expire-awoof-backups`). The expiry `--apply` job has been scheduled since 2026-10-19 (see Activation record below); deploy-time count rotation in `backup-awoof-postgres.sh` also applies. The newest verified backup is always kept as a last-resort recovery copy, so a backup copy can outlive the 30-day window in that case, or where a backup cannot be verified against its integrity manifest and awaits removal through backup maintenance review (excluded from automatic expiry, access-restricted).
   - A backup created on the last day of its rotation containing an active account expires one rotation later.
3. **Total Maximum Retention Window:** The approved academic-profile window plus the configured backup rotation (60 days where both are 30 days), subject to the last-resort newest-backup and unverifiable-backup exceptions above.

### Activation record (2026-10-19)

- `ACADEMIC_PROFILE_ENABLED=true` and `ACADEMIC_PROFILE_RETENTION_DAYS=30` set in the production VPS environment; backend restarted and verified healthy, with the enabled route answering 401 (auth-gated) rather than 403. On 2026-10-20 collection was paused (`ACADEMIC_PROFILE_ENABLED=false`, retention left at 30) until the v1.2 disclosure is deployed; re-enabling immediately after that deploy is the final activation step.
- Purge schedule installed in the production crontab: daily 03:30 UTC, `cleanup-academic-profile-data.js --batch-size 500`, logging to the host log directory; a manual run completed with `deletedProfiles=0`.
- Account closure (the soft-delete trigger for this purge) is implemented as self-service `DELETE /api/students/account`: it sets `users.deleted_at`, revokes all sessions in the same statement, and is student-only; restoration within the retention window is support-mediated by clearing `deleted_at`.
- Backup-expiry schedule installed in the production crontab: daily 04:15 UTC, `expire-awoof-backups.py --backup-dir <production backups> --apply`; a manual dry run completed. Host paths differ from the templates in `scripts/scheduler/` (no system python3 on the host, so the job runs via a pinned `python:3.13-slim` container); the templates remain the reviewed configuration source.

---

## 6. Specific Preservation Exceptions (Legal Holds)

1. **No Blanket Holds:** A general commercial dispute or customer inquiry never constitutes a blanket legal hold over optional academic answers.
2. **Qualifying Grounds:** An exception to automated academic profile erasure applies **only** if:
   - Formally served with a valid court order, subpoena, or written regulatory notice under NDPA § 34(2); or
   - An active formal legal dispute specifically involves the veracity of the academic profile data.
3. **Segregation & Access:** Data subject to a legal hold must be extracted to an encrypted, access-restricted compliance archive accessible only to designated legal officers, and removed from operational student tables.
