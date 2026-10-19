-- Academic Profile Ledger Publication Tracking
--
-- Records when each committed deletion-ledger row has been published to
-- the durable host JSONL ledger. The background dispatcher drains only
-- unpublished rows, so steady-state ticks stay bounded regardless of
-- total erasure history and never depend on wall-clock cursors.

ALTER TABLE academic_profile_deletion_ledger
    ADD COLUMN IF NOT EXISTS host_published_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_academic_profile_deletion_ledger_unpublished
    ON academic_profile_deletion_ledger (erased_at)
    WHERE host_published_at IS NULL;
