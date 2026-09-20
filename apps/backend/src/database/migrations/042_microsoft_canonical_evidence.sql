-- Canonical Graph-enrollment provenance. Existing rows intentionally remain
-- legacy/untrusted for Microsoft: no observation metadata is backfilled.
ALTER TABLE microsoft_provider_proofs
    ADD COLUMN attempt_id UUID REFERENCES microsoft_verification_attempts(id),
    ADD COLUMN observed_at TIMESTAMPTZ,
    ADD COLUMN outcome TEXT,
    ADD COLUMN source TEXT;
CREATE UNIQUE INDEX microsoft_provider_proofs_attempt_unique
    ON microsoft_provider_proofs (attempt_id) WHERE attempt_id IS NOT NULL;
ALTER TABLE microsoft_provider_proofs
    ADD CONSTRAINT microsoft_proofs_observation_contract CHECK (COALESCE(
        (attempt_id IS NULL AND observed_at IS NULL AND outcome IS NULL AND source IS NULL)
        OR
        (attempt_id IS NOT NULL AND observed_at IS NOT NULL
            AND outcome = 'student' AND source = 'microsoft-education:v1')
    , false));

ALTER TABLE eligibility_evidence ADD COLUMN provider_proof_id UUID REFERENCES microsoft_provider_proofs(id);
CREATE UNIQUE INDEX eligibility_evidence_provider_proof_unique
    ON eligibility_evidence (provider_proof_id) WHERE provider_proof_id IS NOT NULL;
ALTER TABLE eligibility_evidence DROP CONSTRAINT IF EXISTS eligibility_evidence_check;
ALTER TABLE eligibility_evidence ADD CONSTRAINT eligibility_evidence_check CHECK (COALESCE(
    (method = 'student_email' AND outcome = 'verified' AND challenge_id IS NOT NULL
        AND source IS NULL AND expires_at IS NOT NULL AND provider_proof_id IS NULL)
    OR
    (method = 'enrollment' AND source IS NOT NULL AND length(btrim(source)) > 0
        AND (source <> 'microsoft-education:v1' OR (outcome = 'verified' AND provider_proof_id IS NOT NULL))
        AND (provider_proof_id IS NULL OR source = 'microsoft-education:v1'))
, false));

CREATE OR REPLACE FUNCTION microsoft_proof_protect() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.university_id IS DISTINCT FROM OLD.university_id OR NEW.provider_consent_id IS DISTINCT FROM OLD.provider_consent_id
        OR NEW.identity_id IS DISTINCT FROM OLD.identity_id OR NEW.provider_policy_version IS DISTINCT FROM OLD.provider_policy_version
        OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id OR NEW.observed_at IS DISTINCT FROM OLD.observed_at
        OR NEW.outcome IS DISTINCT FROM OLD.outcome OR NEW.source IS DISTINCT FROM OLD.source
        OR NEW.created_at IS DISTINCT FROM OLD.created_at OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
        RAISE EXCEPTION 'Microsoft provider proof is immutable except one-way revocation';
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
        OR NEW.provider_proof_id IS DISTINCT FROM OLD.provider_proof_id
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

-- Composite FKs cannot express the student-to-user and parent-grant joins.
-- Keep these provenance links database-enforced rather than relying only on
-- the writer's application checks.
CREATE OR REPLACE FUNCTION microsoft_proof_validate_attempt_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE attempt microsoft_verification_attempts%ROWTYPE;
BEGIN
    IF NEW.attempt_id IS NULL THEN RETURN NEW; END IF;
    SELECT * INTO attempt FROM microsoft_verification_attempts WHERE id = NEW.attempt_id;
    IF NOT FOUND OR attempt.user_id <> NEW.user_id OR attempt.university_id <> NEW.university_id
        OR attempt.provider_consent_id <> NEW.provider_consent_id OR attempt.provider_policy_version <> NEW.provider_policy_version THEN
        RAISE EXCEPTION 'Microsoft provider proof must match its attempt authority';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER microsoft_provider_proof_attempt_binding
    BEFORE INSERT OR UPDATE ON microsoft_provider_proofs
    FOR EACH ROW EXECUTE FUNCTION microsoft_proof_validate_attempt_binding();

CREATE OR REPLACE FUNCTION eligibility_evidence_validate_microsoft_proof() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE proof microsoft_provider_proofs%ROWTYPE; attempt microsoft_verification_attempts%ROWTYPE;
BEGIN
    IF NEW.provider_proof_id IS NULL THEN RETURN NEW; END IF;
    SELECT * INTO proof FROM microsoft_provider_proofs WHERE id = NEW.provider_proof_id;
    SELECT * INTO attempt FROM microsoft_verification_attempts WHERE id = proof.attempt_id;
    IF NOT FOUND OR proof.revoked_at IS NOT NULL OR NEW.source <> 'microsoft-education:v1'
        OR proof.university_id <> NEW.university_id OR attempt.processing_grant_id <> NEW.processing_grant_id
        OR attempt.identity_version <> NEW.identity_version OR attempt.institution_policy_version <> NEW.policy_version
        OR NOT EXISTS (SELECT 1 FROM students WHERE id = NEW.student_id AND user_id = proof.user_id AND university_id = proof.university_id) THEN
        RAISE EXCEPTION 'Microsoft evidence must match provider-proof authority';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER eligibility_evidence_microsoft_proof_binding
    BEFORE INSERT ON eligibility_evidence
    FOR EACH ROW EXECUTE FUNCTION eligibility_evidence_validate_microsoft_proof();
