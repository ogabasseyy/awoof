-- Provider fallback reads only consider immutable, independently verified
-- student-email evidence.  This partial index matches that candidate order.
CREATE INDEX eligibility_evidence_email_fallback_lookup_idx
    ON eligibility_evidence (student_id, university_id, identity_version, policy_version, verified_at DESC, id DESC)
    WHERE method = 'student_email' AND outcome = 'verified' AND revoked_at IS NULL;
