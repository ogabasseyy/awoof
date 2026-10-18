-- Academic Profile Safeguards: Generation Tracking and Deletion Ledger
--
-- Adds opaque server-generated generation tracking to student_academic_profiles
-- and establishes a minimal-metadata deletion ledger for restore-safe
-- disaster-recovery reconciliation.
--
-- The deletion ledger stores strictly minimal metadata (user_id, generation_id,
-- scope, erased_at) and NEVER stores academic answers, names, emails, or PII.

ALTER TABLE student_academic_profiles
    ADD COLUMN IF NOT EXISTS generation_id UUID;

-- Backfill deterministic UUID for existing rows (e.g. when restoring pre-088 backups)
-- so that generation identity is reproducible across pre-migration restores and matches durable tombstones.
UPDATE student_academic_profiles
SET generation_id = CAST(
    substr(md5('awoof_academic_profile_epoch1:' || user_id::text), 1, 8) || '-' ||
    substr(md5('awoof_academic_profile_epoch1:' || user_id::text), 9, 4) || '-4' ||
    substr(md5('awoof_academic_profile_epoch1:' || user_id::text), 14, 3) || '-a' ||
    substr(md5('awoof_academic_profile_epoch1:' || user_id::text), 18, 3) || '-' ||
    substr(md5('awoof_academic_profile_epoch1:' || user_id::text), 21, 12) AS UUID
)
WHERE generation_id IS NULL;

ALTER TABLE student_academic_profiles
    ALTER COLUMN generation_id SET NOT NULL,
    ALTER COLUMN generation_id SET DEFAULT gen_random_uuid();

CREATE TABLE IF NOT EXISTS academic_profile_deletion_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    generation_id UUID NOT NULL,
    scope VARCHAR(32) NOT NULL CHECK (scope IN ('profile_only', 'account_closure')),
    erased_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(),
    reconciled_at TIMESTAMP WITH TIME ZONE NULL
);

CREATE INDEX IF NOT EXISTS idx_academic_deletion_ledger_user ON academic_profile_deletion_ledger (user_id);
CREATE INDEX IF NOT EXISTS idx_academic_deletion_ledger_erased_at ON academic_profile_deletion_ledger (erased_at);
CREATE INDEX IF NOT EXISTS idx_academic_deletion_ledger_lookup ON academic_profile_deletion_ledger (user_id, generation_id);
