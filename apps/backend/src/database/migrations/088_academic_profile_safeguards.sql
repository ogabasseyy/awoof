-- Academic Profile Safeguards: Generation Tracking and Deletion Ledger
--
-- Adds opaque server-generated generation tracking to student_academic_profiles
-- and establishes a minimal-metadata deletion ledger for restore-safe
-- disaster-recovery reconciliation.
--
-- The deletion ledger stores strictly minimal metadata (user_id, generation_id,
-- scope, erased_at) and NEVER stores academic answers, names, emails, or PII.

ALTER TABLE student_academic_profiles
    ADD COLUMN IF NOT EXISTS generation_id UUID NOT NULL DEFAULT gen_random_uuid();

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
