-- Microsoft verification authority is provider-scoped.  It never changes the
-- existing institution email-verification policy version.
CREATE OR REPLACE FUNCTION microsoft_scopes_are_canonical(input_scopes TEXT[]) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
    SELECT input_scopes IS NOT NULL
       AND NOT EXISTS (
           SELECT 1 FROM unnest(input_scopes) scope
           WHERE scope IS NULL OR scope = '' OR scope ~ '[[:space:]]'
       )
       AND input_scopes = ARRAY(SELECT DISTINCT scope FROM unnest(input_scopes) scope ORDER BY scope)
$$;

CREATE TABLE microsoft_published_notices (
    version TEXT PRIMARY KEY CHECK (length(btrim(version)) > 0),
    content TEXT NOT NULL CHECK (length(btrim(content)) > 0),
    content_digest TEXT NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
    published_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (content_digest)
);
INSERT INTO microsoft_published_notices (version, content, content_digest) VALUES
    ('microsoft-v1', 'We use Microsoft school identity information to assess student eligibility. You can withdraw Microsoft provider consent.', 'e1c0286bb275402f93a40ae5326d8d84cf8ef06798cd82d1dd9f8e8c01503a55'),
    ('microsoft-v2', 'We use Microsoft school identity and, where approved, enrollment information to assess student eligibility. You can withdraw Microsoft provider consent.', 'c89e12f29357a2858e2ad8d4540b4f8b551eb3df3a5a2d3617d939c2702c269e');
CREATE OR REPLACE FUNCTION microsoft_published_notice_protect() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'published Microsoft notice copies are immutable'; END $$;
CREATE TRIGGER microsoft_published_notice_before_change BEFORE UPDATE OR DELETE ON microsoft_published_notices
    FOR EACH ROW EXECUTE FUNCTION microsoft_published_notice_protect();

CREATE TABLE institution_microsoft_policies (
    university_id UUID PRIMARY KEY REFERENCES universities(id),
    tenant_id UUID NOT NULL UNIQUE,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    enabled BOOLEAN NOT NULL DEFAULT false,
    mode TEXT NOT NULL CHECK (mode IN ('identity_only', 'graph_enrollment')),
    approved_until TIMESTAMPTZ NOT NULL,
    approved_by UUID NOT NULL REFERENCES users(id),
    term_ends_at TIMESTAMPTZ,
    max_evidence_hours INTEGER NOT NULL CHECK (max_evidence_hours BETWEEN 1 AND 24),
    scopes TEXT[] NOT NULL DEFAULT '{}',
    notice_version TEXT NOT NULL REFERENCES microsoft_published_notices(version),
    CHECK (microsoft_scopes_are_canonical(scopes)),
    CHECK (mode <> 'graph_enrollment' OR term_ends_at IS NOT NULL)
);

CREATE OR REPLACE FUNCTION microsoft_policy_validate_and_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.enabled AND NEW.mode = 'graph_enrollment' AND (NEW.term_ends_at IS NULL OR NEW.term_ends_at <= clock_timestamp()
        OR NEW.approved_until <= clock_timestamp()) THEN
        RAISE EXCEPTION 'graph Microsoft policy requires a current approval and term boundary';
    END IF;
    IF TG_OP = 'UPDATE' AND (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        OR NEW.enabled IS DISTINCT FROM OLD.enabled OR NEW.mode IS DISTINCT FROM OLD.mode
        OR NEW.approved_until IS DISTINCT FROM OLD.approved_until OR NEW.term_ends_at IS DISTINCT FROM OLD.term_ends_at
        OR NEW.max_evidence_hours IS DISTINCT FROM OLD.max_evidence_hours OR NEW.scopes IS DISTINCT FROM OLD.scopes
        OR NEW.notice_version IS DISTINCT FROM OLD.notice_version) THEN
        NEW.version := OLD.version + 1;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER microsoft_policy_before_write
    BEFORE INSERT OR UPDATE ON institution_microsoft_policies
    FOR EACH ROW EXECUTE FUNCTION microsoft_policy_validate_and_version();

CREATE TABLE microsoft_identities (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id),
    university_id UUID NOT NULL REFERENCES universities(id),
    tenant_id UUID NOT NULL,
    object_id UUID NOT NULL,
    linked_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    revoked_at TIMESTAMPTZ,
    UNIQUE (tenant_id, object_id)
);
ALTER TABLE microsoft_identities
    ADD CONSTRAINT microsoft_identities_id_user_institution_unique UNIQUE (id, user_id, university_id);
CREATE UNIQUE INDEX microsoft_identities_active_user_institution_unique
    ON microsoft_identities (user_id, university_id) WHERE revoked_at IS NULL;

CREATE TABLE microsoft_verification_consents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id),
    university_id UUID NOT NULL REFERENCES universities(id),
    processing_grant_id UUID NOT NULL,
    provider_policy_version INTEGER NOT NULL CHECK (provider_policy_version >= 1),
    notice_version TEXT NOT NULL REFERENCES microsoft_published_notices(version),
    mode TEXT NOT NULL CHECK (mode IN ('identity_only', 'graph_enrollment')),
    scopes TEXT[] NOT NULL,
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    withdrawn_at TIMESTAMPTZ,
    CHECK (microsoft_scopes_are_canonical(scopes))
);
ALTER TABLE verification_consents
    ADD CONSTRAINT verification_consents_id_user_institution_unique UNIQUE (id, user_id, university_id);
ALTER TABLE microsoft_verification_consents
    ADD CONSTRAINT microsoft_consents_parent_subject_fk
        FOREIGN KEY (processing_grant_id, user_id, university_id)
        REFERENCES verification_consents (id, user_id, university_id),
    ADD CONSTRAINT microsoft_consents_id_subject_parent_unique
        UNIQUE (id, user_id, university_id, processing_grant_id),
    ADD CONSTRAINT microsoft_consents_id_subject_unique UNIQUE (id, user_id, university_id);
CREATE INDEX microsoft_verification_consents_live_idx
    ON microsoft_verification_consents (user_id, university_id, id) WHERE withdrawn_at IS NULL;

CREATE TABLE microsoft_verification_attempts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id),
    university_id UUID NOT NULL REFERENCES universities(id),
    institution_policy_version INTEGER NOT NULL CHECK (institution_policy_version >= 1),
    provider_policy_version INTEGER NOT NULL CHECK (provider_policy_version >= 1),
    identity_version INTEGER NOT NULL CHECK (identity_version >= 1),
    processing_grant_id UUID NOT NULL,
    provider_consent_id UUID NOT NULL,
    server_session_id UUID NOT NULL,
    state_hash TEXT NOT NULL UNIQUE,
    browser_secret_hash TEXT NOT NULL,
    finish_secret_hash TEXT NOT NULL,
    encrypted_verifier TEXT,
    nonce TEXT,
    result JSONB,
    expires_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'ready', 'completed', 'failed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CHECK ((status IN ('pending', 'processing') AND encrypted_verifier IS NOT NULL AND nonce IS NOT NULL)
        OR status IN ('ready', 'completed', 'failed'))
);
ALTER TABLE microsoft_verification_attempts
    ADD CONSTRAINT microsoft_attempts_parent_subject_fk
        FOREIGN KEY (processing_grant_id, user_id, university_id)
        REFERENCES verification_consents (id, user_id, university_id),
    ADD CONSTRAINT microsoft_attempts_provider_subject_parent_fk
        FOREIGN KEY (provider_consent_id, user_id, university_id, processing_grant_id)
        REFERENCES microsoft_verification_consents (id, user_id, university_id, processing_grant_id);
CREATE INDEX microsoft_verification_attempts_expiry_idx ON microsoft_verification_attempts (expires_at);

CREATE OR REPLACE FUNCTION microsoft_policy_cancel_pending_attempts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.version IS DISTINCT FROM OLD.version THEN
        UPDATE microsoft_verification_attempts
        SET status = 'failed', encrypted_verifier = NULL, nonce = NULL, result = NULL
        WHERE university_id = NEW.university_id AND status IN ('pending', 'processing', 'ready');
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER microsoft_policy_after_update
    AFTER UPDATE ON institution_microsoft_policies
    FOR EACH ROW EXECUTE FUNCTION microsoft_policy_cancel_pending_attempts();

CREATE TABLE microsoft_provider_proofs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id),
    university_id UUID NOT NULL REFERENCES universities(id),
    provider_consent_id UUID NOT NULL,
    identity_id UUID NOT NULL,
    provider_policy_version INTEGER NOT NULL CHECK (provider_policy_version >= 1),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    revoked_at TIMESTAMPTZ
);
ALTER TABLE microsoft_provider_proofs
    ADD CONSTRAINT microsoft_proofs_consent_subject_fk
        FOREIGN KEY (provider_consent_id, user_id, university_id)
        REFERENCES microsoft_verification_consents (id, user_id, university_id),
    ADD CONSTRAINT microsoft_proofs_identity_subject_fk
        FOREIGN KEY (identity_id, user_id, university_id)
        REFERENCES microsoft_identities (id, user_id, university_id);
CREATE INDEX microsoft_provider_proofs_live_consent_idx
    ON microsoft_provider_proofs (provider_consent_id) WHERE revoked_at IS NULL;

CREATE OR REPLACE FUNCTION microsoft_proof_protect() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.university_id IS DISTINCT FROM OLD.university_id OR NEW.provider_consent_id IS DISTINCT FROM OLD.provider_consent_id
        OR NEW.identity_id IS DISTINCT FROM OLD.identity_id OR NEW.provider_policy_version IS DISTINCT FROM OLD.provider_policy_version
        OR NEW.created_at IS DISTINCT FROM OLD.created_at OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
        RAISE EXCEPTION 'Microsoft provider proof is immutable except one-way revocation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER microsoft_provider_proof_before_update
    BEFORE UPDATE ON microsoft_provider_proofs FOR EACH ROW EXECUTE FUNCTION microsoft_proof_protect();
