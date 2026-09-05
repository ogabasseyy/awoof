-- Explicit eligibility authority. This migration deliberately backfills no legacy
-- verification state: pre-existing verified accounts must establish fresh proof.
DO $$
DECLARE
    duplicate_students BIGINT;
    duplicate_emails BIGINT;
BEGIN
    SELECT count(*) INTO duplicate_students
    FROM (
        SELECT user_id FROM students GROUP BY user_id HAVING count(*) > 1
    ) duplicates;
    IF duplicate_students > 0 THEN
        RAISE EXCEPTION
            'eligibility migration blocked: % duplicate students.user_id groups; operator diagnostic: SELECT user_id, count(*) FROM students GROUP BY user_id HAVING count(*) > 1',
            duplicate_students;
    END IF;

    SELECT count(*) INTO duplicate_emails
    FROM (
        SELECT lower(btrim(email)) FROM users GROUP BY lower(btrim(email)) HAVING count(*) > 1
    ) duplicates;
    IF duplicate_emails > 0 THEN
        RAISE EXCEPTION
            'eligibility migration blocked: % duplicate normalized users.email groups; operator diagnostic: SELECT lower(btrim(email)), count(*) FROM users GROUP BY 1 HAVING count(*) > 1',
            duplicate_emails;
    END IF;
END $$;

DROP INDEX IF EXISTS idx_students_registration_unique;
CREATE UNIQUE INDEX IF NOT EXISTS students_user_unique ON students (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS users_normalized_email_unique ON users (lower(btrim(email)));

ALTER TABLE students
    ADD COLUMN IF NOT EXISTS identity_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE universities
    ADD COLUMN IF NOT EXISTS verification_policy_version INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS email_evidence_validity_days INTEGER NOT NULL DEFAULT 90
        CHECK (email_evidence_validity_days BETWEEN 1 AND 365),
    ADD COLUMN IF NOT EXISTS enrollment_validity_days INTEGER NOT NULL DEFAULT 30
        CHECK (enrollment_validity_days BETWEEN 1 AND 365),
    ADD COLUMN IF NOT EXISTS registration_normalization TEXT
        CHECK (registration_normalization IN ('exact', 'trim_upper'));
ALTER TABLE widget_configs
    ADD COLUMN IF NOT EXISTS allowed_origins TEXT[] NOT NULL DEFAULT '{}';

CREATE TABLE approved_student_email_domains (
    university_id UUID NOT NULL REFERENCES universities(id),
    domain TEXT NOT NULL CHECK (domain = lower(btrim(domain)) AND domain !~ '[:/@*]'),
    is_active BOOLEAN NOT NULL DEFAULT true,
    approved_by UUID NOT NULL REFERENCES users(id),
    approved_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (university_id, domain)
);
CREATE INDEX approved_student_email_domains_active_idx
    ON approved_student_email_domains (university_id, domain) WHERE is_active;

CREATE TABLE verification_consents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL CHECK (kind IN ('processing', 'disclosure')),
    university_id UUID REFERENCES universities(id),
    vendor_id UUID REFERENCES vendors(id),
    origin TEXT,
    purpose TEXT,
    notice_version TEXT NOT NULL CHECK (length(btrim(notice_version)) > 0),
    accepted BOOLEAN NOT NULL DEFAULT true CHECK (accepted),
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    withdrawn_at TIMESTAMPTZ,
    CHECK (
        (kind = 'processing' AND university_id IS NOT NULL AND vendor_id IS NULL AND origin IS NULL AND purpose IS NULL)
        OR
        (kind = 'disclosure' AND university_id IS NULL AND vendor_id IS NOT NULL AND origin IS NOT NULL AND purpose IS NOT NULL)
    )
);
CREATE INDEX verification_consents_processing_current_idx
    ON verification_consents (user_id, university_id, id) WHERE kind = 'processing' AND withdrawn_at IS NULL;
CREATE INDEX verification_consents_disclosure_current_idx
    ON verification_consents (user_id, vendor_id, origin, purpose, id)
    WHERE kind = 'disclosure' AND withdrawn_at IS NULL;

CREATE TABLE user_email_proofs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id),
    email TEXT NOT NULL CHECK (email = lower(btrim(email))),
    challenge_id UUID NOT NULL UNIQUE REFERENCES verification_challenges(id),
    proven_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX user_email_proofs_current_mailbox_idx ON user_email_proofs (user_id, email, proven_at DESC);

CREATE TABLE eligibility_evidence (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    student_id UUID NOT NULL REFERENCES students(id),
    university_id UUID NOT NULL REFERENCES universities(id),
    email_proof_id UUID NOT NULL REFERENCES user_email_proofs(id),
    processing_grant_id UUID NOT NULL REFERENCES verification_consents(id),
    challenge_id UUID UNIQUE REFERENCES verification_challenges(id),
    method TEXT NOT NULL CHECK (method IN ('student_email', 'enrollment')),
    outcome TEXT NOT NULL CHECK (outcome IN ('verified', 'denied')),
    identity_version INTEGER NOT NULL CHECK (identity_version >= 1),
    policy_version INTEGER NOT NULL CHECK (policy_version >= 1),
    source TEXT,
    verified_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    revocation_reason TEXT,
    CHECK (
        (method = 'student_email' AND outcome = 'verified' AND challenge_id IS NOT NULL
            AND source IS NULL AND expires_at IS NOT NULL)
        OR
        (method = 'enrollment' AND source IS NOT NULL AND length(btrim(source)) > 0)
    )
);
CREATE INDEX eligibility_evidence_current_lookup_idx
    ON eligibility_evidence (student_id, university_id, verified_at DESC);

CREATE TABLE student_eligibility_state (
    student_id UUID NOT NULL REFERENCES students(id),
    university_id UUID NOT NULL REFERENCES universities(id),
    current_evidence_id UUID REFERENCES eligibility_evidence(id),
    authoritative_denial BOOLEAN NOT NULL DEFAULT false,
    provider_request_generation INTEGER NOT NULL DEFAULT 0 CHECK (provider_request_generation >= 0),
    provider_applied_generation INTEGER NOT NULL DEFAULT 0 CHECK (provider_applied_generation >= 0),
    CHECK (provider_applied_generation <= provider_request_generation),
    PRIMARY KEY (student_id, university_id)
);

CREATE TABLE verified_registration_identities (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    university_id UUID NOT NULL REFERENCES universities(id),
    identifier TEXT NOT NULL CHECK (length(btrim(identifier)) > 0),
    student_id UUID NOT NULL REFERENCES students(id),
    revoked_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX verified_registration_identity_active_unique
    ON verified_registration_identities (university_id, identifier) WHERE revoked_at IS NULL;

CREATE TABLE verification_audit_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    actor_user_id UUID REFERENCES users(id),
    user_id UUID REFERENCES users(id),
    university_id UUID REFERENCES universities(id),
    event_type TEXT NOT NULL CHECK (length(btrim(event_type)) > 0),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX verification_audit_events_subject_idx ON verification_audit_events (user_id, created_at DESC);
CREATE INDEX verification_audit_events_institution_idx ON verification_audit_events (university_id, created_at DESC);

CREATE OR REPLACE FUNCTION eligibility_bump_university_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.is_active IS DISTINCT FROM OLD.is_active
        OR NEW.email_evidence_validity_days IS DISTINCT FROM OLD.email_evidence_validity_days
        OR NEW.enrollment_validity_days IS DISTINCT FROM OLD.enrollment_validity_days
        OR NEW.registration_normalization IS DISTINCT FROM OLD.registration_normalization THEN
        NEW.verification_policy_version := OLD.verification_policy_version + 1;
    END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION eligibility_bump_domain_policy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    changed_university UUID;
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.domain IS NOT DISTINCT FROM OLD.domain
        AND NEW.is_active IS NOT DISTINCT FROM OLD.is_active THEN
        RETURN NEW;
    END IF;
    changed_university := COALESCE(NEW.university_id, OLD.university_id);
    UPDATE universities
    SET verification_policy_version = verification_policy_version + 1
    WHERE id = changed_university;
    RETURN COALESCE(NEW, OLD);
END $$;

CREATE OR REPLACE FUNCTION eligibility_reject_domain_reparent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.university_id IS DISTINCT FROM OLD.university_id THEN
        RAISE EXCEPTION 'approved student email domains cannot be reparented; remove and add under the target institution';
    END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION eligibility_bump_method_policy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    changed_university UUID;
BEGIN
    IF TG_OP = 'UPDATE'
        AND NEW.method_type IS NOT DISTINCT FROM OLD.method_type
        AND NEW.api_endpoint IS NOT DISTINCT FROM OLD.api_endpoint
        AND NEW.api_config IS NOT DISTINCT FROM OLD.api_config
        AND NEW.is_active IS NOT DISTINCT FROM OLD.is_active THEN
        RETURN NEW;
    END IF;
    IF (TG_OP <> 'DELETE' AND NEW.method_type = 'registration' AND NEW.is_active)
        OR (TG_OP <> 'INSERT' AND OLD.method_type = 'registration' AND OLD.is_active) THEN
        changed_university := COALESCE(NEW.university_id, OLD.university_id);
        UPDATE universities
        SET verification_policy_version = verification_policy_version + 1
        WHERE id = changed_university;
    END IF;
    RETURN COALESCE(NEW, OLD);
END $$;

CREATE OR REPLACE FUNCTION eligibility_reject_method_reparent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.university_id IS DISTINCT FROM OLD.university_id THEN
        RAISE EXCEPTION 'university verification methods cannot be reparented; remove and add under the target institution';
    END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION eligibility_bump_student_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.name IS DISTINCT FROM OLD.name
        OR NEW.university_id IS DISTINCT FROM OLD.university_id
        OR NEW.registration_number IS DISTINCT FROM OLD.registration_number
        OR NEW.status IS DISTINCT FROM OLD.status THEN
        NEW.identity_version := OLD.identity_version + 1;
    END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION eligibility_bump_user_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF lower(btrim(NEW.email)) IS DISTINCT FROM lower(btrim(OLD.email))
        OR NEW.role IS DISTINCT FROM OLD.role
        OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
        UPDATE students
        SET identity_version = identity_version + 1
        WHERE user_id = NEW.id;
    END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION eligibility_protect_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.student_id IS DISTINCT FROM OLD.student_id
        OR NEW.university_id IS DISTINCT FROM OLD.university_id
        OR NEW.email_proof_id IS DISTINCT FROM OLD.email_proof_id
        OR NEW.processing_grant_id IS DISTINCT FROM OLD.processing_grant_id
        OR NEW.challenge_id IS DISTINCT FROM OLD.challenge_id
        OR NEW.method IS DISTINCT FROM OLD.method
        OR NEW.outcome IS DISTINCT FROM OLD.outcome
        OR NEW.identity_version IS DISTINCT FROM OLD.identity_version
        OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
        OR NEW.source IS DISTINCT FROM OLD.source
        OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
        OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
        OR OLD.revoked_at IS NOT NULL
        OR NEW.revoked_at IS NULL THEN
        RAISE EXCEPTION 'eligibility evidence is immutable except one-way revocation';
    END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION eligibility_protect_audit_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'verification audit events are append-only';
END $$;

CREATE TRIGGER eligibility_university_policy_before_update
    BEFORE UPDATE ON universities FOR EACH ROW EXECUTE FUNCTION eligibility_bump_university_policy();
CREATE TRIGGER eligibility_domain_before_reparent
    BEFORE UPDATE ON approved_student_email_domains FOR EACH ROW EXECUTE FUNCTION eligibility_reject_domain_reparent();
CREATE TRIGGER eligibility_domain_policy_after_change
    AFTER INSERT OR UPDATE OR DELETE ON approved_student_email_domains
    FOR EACH ROW EXECUTE FUNCTION eligibility_bump_domain_policy();
CREATE TRIGGER eligibility_method_before_reparent
    BEFORE UPDATE ON university_verification_methods FOR EACH ROW EXECUTE FUNCTION eligibility_reject_method_reparent();
CREATE TRIGGER eligibility_method_policy_after_change
    AFTER INSERT OR UPDATE OR DELETE ON university_verification_methods
    FOR EACH ROW EXECUTE FUNCTION eligibility_bump_method_policy();
CREATE TRIGGER eligibility_student_identity_before_update
    BEFORE UPDATE ON students FOR EACH ROW EXECUTE FUNCTION eligibility_bump_student_identity();
CREATE TRIGGER eligibility_user_identity_after_update
    AFTER UPDATE ON users FOR EACH ROW EXECUTE FUNCTION eligibility_bump_user_identity();
CREATE TRIGGER eligibility_evidence_before_update
    BEFORE UPDATE ON eligibility_evidence FOR EACH ROW EXECUTE FUNCTION eligibility_protect_evidence();
CREATE TRIGGER eligibility_evidence_before_delete
    BEFORE DELETE ON eligibility_evidence FOR EACH ROW EXECUTE FUNCTION eligibility_protect_audit_event();
CREATE TRIGGER verification_audit_events_before_update
    BEFORE UPDATE ON verification_audit_events FOR EACH ROW EXECUTE FUNCTION eligibility_protect_audit_event();
CREATE TRIGGER verification_audit_events_before_delete
    BEFORE DELETE ON verification_audit_events FOR EACH ROW EXECUTE FUNCTION eligibility_protect_audit_event();
