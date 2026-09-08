-- Preserve evidence/audit identifiers while removing obsolete challenge secrets and PII.
ALTER TABLE verification_challenges ADD COLUMN purged_at TIMESTAMPTZ;
CREATE INDEX verification_challenges_retention_idx ON verification_challenges (expires_at)
    WHERE purged_at IS NULL;

-- Identity changes already bump identity_version, including user email/role/deletion.
-- Release the reservation in that same transaction, before another student can claim it.
CREATE FUNCTION eligibility_release_registration_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.identity_version IS DISTINCT FROM OLD.identity_version THEN
        UPDATE verified_registration_identities SET revoked_at = clock_timestamp()
        WHERE student_id = NEW.id AND revoked_at IS NULL;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER release_registration_identity AFTER UPDATE ON students
    FOR EACH ROW EXECUTE FUNCTION eligibility_release_registration_identity();

-- Repair reservations whose owning identity has already changed since verification.
UPDATE verified_registration_identities r SET revoked_at = clock_timestamp()
FROM students s JOIN users u ON u.id = s.user_id
WHERE r.student_id = s.id AND r.revoked_at IS NULL
AND (s.status <> 'active' OR u.deleted_at IS NOT NULL OR u.role <> 'student'
     OR r.university_id IS DISTINCT FROM s.university_id
     OR NOT EXISTS (
        SELECT 1 FROM eligibility_evidence e
        WHERE e.student_id = s.id AND e.university_id = r.university_id
          AND e.identity_version = s.identity_version AND e.method = 'enrollment'
          AND e.outcome = 'verified'
     ));
