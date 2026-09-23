-- Task B1: durable student SSO login policy, identities, and attempts.
--
-- Additive only. This migration creates the greenfield login storage
-- contract and adds UNIQUE(id, user_id) to user_email_proofs (primary key
-- on id only at baseline) so school assertions can bind mailbox evidence to
-- its owner. It does not modify any microsoft_* table, does not backfill
-- session provenance, and writes no seed approval: an empty policy table
-- stays disabled until an administrator approves an institution.
--
-- Writer rules enforced here versus in application code:
-- - Policy trust edits must increment version while holding the policy row
--   lock; the B2/B4 writers own that discipline.
-- - SSO identity/policy university and provider matching, approved
--   mailbox-domain membership, and consent checks belong to the canonical
--   locked assertion writer (B4). The database pins owner binding,
--   single-source evidence, status payloads, and one-way transitions below.
-- - Cleanup (B3 script) scrubs expired attempt/handoff ciphertext within one
--   scheduled hour and deletes non-audit transient records after seven days.
--   Identity, assertion, and revocation rows are retained under account
--   retention rules and therefore cannot be deleted here.
-- - Discovery (B2) joins active universities, enabled unexpired policies,
--   and active domain mappings only; inactive universities never resolve.

-- Owner composite key for mailbox evidence. Verified absent at baseline
-- (030 creates PK(id) plus a (user_id, email, proven_at) index only), so a
-- plain ADD CONSTRAINT is safe on existing rows: id is already unique.
ALTER TABLE user_email_proofs
    ADD CONSTRAINT user_email_proofs_id_user_unique UNIQUE (id, user_id);

CREATE TABLE IF NOT EXISTS institution_login_policies (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    university_id uuid NOT NULL REFERENCES universities(id),
    provider text NOT NULL CHECK (provider IN ('google', 'microsoft')),
    issuer text NOT NULL CHECK (length(btrim(issuer)) > 0),
    provider_realm text NOT NULL CHECK (length(btrim(provider_realm)) > 0),
    version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
    enabled boolean NOT NULL DEFAULT false,
    approved_until timestamptz,
    approved_by uuid REFERENCES users(id),
    school_assertion_days integer NOT NULL CHECK (school_assertion_days BETWEEN 1 AND 90),
    UNIQUE (university_id, provider),
    UNIQUE (id, university_id, provider)
);
CREATE INDEX IF NOT EXISTS idx_institution_login_policies_approval
    ON institution_login_policies (approved_until) WHERE enabled;

CREATE TABLE IF NOT EXISTS institution_login_domains (
    domain text PRIMARY KEY CHECK (domain = lower(btrim(domain)) AND length(domain) > 0),
    university_id uuid NOT NULL REFERENCES universities(id),
    is_active boolean NOT NULL DEFAULT true,
    UNIQUE (domain, university_id)
);
CREATE INDEX IF NOT EXISTS idx_institution_login_domains_university
    ON institution_login_domains (university_id);

CREATE TABLE IF NOT EXISTS institution_login_domain_providers (
    domain text NOT NULL,
    university_id uuid NOT NULL,
    provider text NOT NULL CHECK (provider IN ('google', 'microsoft')),
    policy_id uuid NOT NULL,
    PRIMARY KEY (domain, provider),
    FOREIGN KEY (domain, university_id)
        REFERENCES institution_login_domains (domain, university_id),
    FOREIGN KEY (policy_id, university_id, provider)
        REFERENCES institution_login_policies (id, university_id, provider)
);

CREATE TABLE IF NOT EXISTS student_auth_identities (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id uuid NOT NULL REFERENCES users(id),
    university_id uuid NOT NULL REFERENCES universities(id),
    provider text NOT NULL CHECK (provider IN ('google', 'microsoft')),
    issuer text NOT NULL CHECK (length(btrim(issuer)) > 0),
    subject text NOT NULL CHECK (length(btrim(subject)) > 0),
    observed_email text,
    revoked_at timestamptz,
    linked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (provider, issuer, subject),
    UNIQUE (id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_student_auth_identities_owner
    ON student_auth_identities (user_id, university_id);

-- One identity row is one owner's tombstone: the owner key never moves, so a
-- revoked identity can never transfer to another account. Revocation itself
-- stays a lifecycle timestamp because the original owner may reactivate after
-- fresh proof (B4); latest provider email observations remain writable since
-- they are never ownership evidence.
CREATE OR REPLACE FUNCTION student_sso_identity_protect() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.university_id IS DISTINCT FROM OLD.university_id
        OR NEW.provider IS DISTINCT FROM OLD.provider OR NEW.issuer IS DISTINCT FROM OLD.issuer
        OR NEW.subject IS DISTINCT FROM OLD.subject OR NEW.linked_at IS DISTINCT FROM OLD.linked_at THEN
        RAISE EXCEPTION 'SSO identity ownership is immutable and cannot transfer';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER student_sso_identity_before_update
    BEFORE UPDATE ON student_auth_identities FOR EACH ROW EXECUTE FUNCTION student_sso_identity_protect();

CREATE OR REPLACE FUNCTION student_sso_identity_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'SSO identities are retained under account retention rules and cannot be deleted';
END $$;
CREATE TRIGGER student_sso_identity_before_delete
    BEFORE DELETE ON student_auth_identities FOR EACH ROW EXECUTE FUNCTION student_sso_identity_no_delete();

CREATE TABLE IF NOT EXISTS student_school_assertions (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id uuid NOT NULL REFERENCES users(id),
    university_id uuid NOT NULL REFERENCES universities(id),
    source text NOT NULL CHECK (source IN ('email_otp', 'google_workspace', 'microsoft_school')),
    email_proof_id uuid,
    auth_identity_id uuid,
    login_policy_id uuid REFERENCES institution_login_policies(id),
    policy_version integer NOT NULL CHECK (policy_version >= 1),
    identity_version integer NOT NULL CHECK (identity_version >= 1),
    verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    CHECK (
        (source = 'email_otp' AND email_proof_id IS NOT NULL
            AND auth_identity_id IS NULL AND login_policy_id IS NULL)
        OR
        (source IN ('google_workspace', 'microsoft_school') AND email_proof_id IS NULL
            AND auth_identity_id IS NOT NULL AND login_policy_id IS NOT NULL)
    ),
    FOREIGN KEY (email_proof_id, user_id) REFERENCES user_email_proofs (id, user_id),
    FOREIGN KEY (auth_identity_id, user_id) REFERENCES student_auth_identities (id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_student_school_assertions_owner
    ON student_school_assertions (user_id, university_id);
CREATE INDEX IF NOT EXISTS idx_student_school_assertions_expiry
    ON student_school_assertions (expires_at) WHERE revoked_at IS NULL;

CREATE OR REPLACE FUNCTION student_sso_assertion_protect() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.university_id IS DISTINCT FROM OLD.university_id OR NEW.source IS DISTINCT FROM OLD.source
        OR NEW.email_proof_id IS DISTINCT FROM OLD.email_proof_id
        OR NEW.auth_identity_id IS DISTINCT FROM OLD.auth_identity_id
        OR NEW.login_policy_id IS DISTINCT FROM OLD.login_policy_id
        OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
        OR NEW.identity_version IS DISTINCT FROM OLD.identity_version
        OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
        OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
        OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
        RAISE EXCEPTION 'School assertion is immutable except one-way revocation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER student_sso_assertion_before_update
    BEFORE UPDATE ON student_school_assertions FOR EACH ROW EXECUTE FUNCTION student_sso_assertion_protect();

CREATE OR REPLACE FUNCTION student_sso_assertion_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'School assertions are retained audit records and cannot be deleted';
END $$;
CREATE TRIGGER student_sso_assertion_before_delete
    BEFORE DELETE ON student_school_assertions FOR EACH ROW EXECUTE FUNCTION student_sso_assertion_no_delete();

CREATE TABLE IF NOT EXISTS student_auth_attempts (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    policy_id uuid NOT NULL REFERENCES institution_login_policies(id),
    policy_version integer NOT NULL CHECK (policy_version >= 1),
    provider text NOT NULL CHECK (provider IN ('google', 'microsoft')),
    requested_email text NOT NULL CHECK (length(btrim(requested_email)) > 0),
    state_hash text NOT NULL UNIQUE,
    callback_cookie_hash text NOT NULL,
    finish_secret_hash text NOT NULL,
    encrypted_verifier text,
    nonce text,
    encrypted_observation text,
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'ready', 'consumed', 'failed')),
    expires_at timestamptz NOT NULL,
    remember_me boolean NOT NULL DEFAULT false,
    return_path text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (expires_at <= created_at + interval '10 minutes'),
    CHECK (
        status NOT IN ('pending', 'processing')
        OR (encrypted_verifier IS NOT NULL AND nonce IS NOT NULL)
    ),
    CHECK (status <> 'ready' OR encrypted_observation IS NOT NULL),
    CHECK (
        status NOT IN ('consumed', 'failed')
        OR (encrypted_verifier IS NULL AND nonce IS NULL AND encrypted_observation IS NULL)
    )
);
CREATE INDEX IF NOT EXISTS idx_student_auth_attempts_status_expiry
    ON student_auth_attempts (status, expires_at);
CREATE INDEX IF NOT EXISTS idx_student_auth_attempts_policy
    ON student_auth_attempts (policy_id);

CREATE OR REPLACE FUNCTION student_sso_attempt_terminal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status IN ('consumed', 'failed') AND NEW.status IS DISTINCT FROM OLD.status THEN
        RAISE EXCEPTION 'Terminal SSO attempts cannot transition back';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER student_sso_attempt_before_update
    BEFORE UPDATE ON student_auth_attempts FOR EACH ROW EXECUTE FUNCTION student_sso_attempt_terminal();

CREATE TABLE IF NOT EXISTS student_auth_link_handoffs (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    attempt_id uuid NOT NULL UNIQUE REFERENCES student_auth_attempts(id),
    secret_hash text NOT NULL UNIQUE,
    encrypted_observation text NOT NULL,
    policy_id uuid NOT NULL REFERENCES institution_login_policies(id),
    policy_version integer NOT NULL CHECK (policy_version >= 1),
    browser_binding_hash text NOT NULL,
    target_user_id uuid REFERENCES users(id),
    target_sid uuid,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (expires_at <= created_at + interval '10 minutes'),
    CHECK ((target_user_id IS NULL) = (target_sid IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_student_auth_link_handoffs_expiry
    ON student_auth_link_handoffs (expires_at);
CREATE INDEX IF NOT EXISTS idx_student_auth_link_handoffs_policy
    ON student_auth_link_handoffs (policy_id);

CREATE OR REPLACE FUNCTION student_sso_handoff_consume_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.consumed_at IS NOT NULL
        AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
            OR NEW.secret_hash IS DISTINCT FROM OLD.secret_hash
            OR NEW.encrypted_observation IS DISTINCT FROM OLD.encrypted_observation
            OR NEW.policy_id IS DISTINCT FROM OLD.policy_id
            OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
            OR NEW.browser_binding_hash IS DISTINCT FROM OLD.browser_binding_hash
            OR NEW.target_user_id IS DISTINCT FROM OLD.target_user_id
            OR NEW.target_sid IS DISTINCT FROM OLD.target_sid
            OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
            OR NEW.consumed_at IS DISTINCT FROM OLD.consumed_at
            OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
        RAISE EXCEPTION 'Consumed SSO handoffs cannot be replayed or rewritten';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER student_sso_handoff_before_update
    BEFORE UPDATE ON student_auth_link_handoffs FOR EACH ROW EXECUTE FUNCTION student_sso_handoff_consume_once();

CREATE TABLE IF NOT EXISTS student_auth_reauth_grants (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id uuid NOT NULL REFERENCES users(id),
    sid uuid NOT NULL,
    purpose text NOT NULL CHECK (purpose IN ('link', 'unlink')),
    secret_hash text NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (expires_at <= created_at + interval '5 minutes')
);
CREATE INDEX IF NOT EXISTS idx_student_auth_reauth_grants_owner_expiry
    ON student_auth_reauth_grants (user_id, expires_at);

CREATE OR REPLACE FUNCTION student_sso_grant_consume_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.consumed_at IS NOT NULL
        AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
            OR NEW.sid IS DISTINCT FROM OLD.sid OR NEW.purpose IS DISTINCT FROM OLD.purpose
            OR NEW.secret_hash IS DISTINCT FROM OLD.secret_hash
            OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
            OR NEW.consumed_at IS DISTINCT FROM OLD.consumed_at
            OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
        RAISE EXCEPTION 'Consumed reauth grants cannot be reused or rewritten';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER student_sso_grant_before_update
    BEFORE UPDATE ON student_auth_reauth_grants FOR EACH ROW EXECUTE FUNCTION student_sso_grant_consume_once();

-- Session provenance. Nullable with no backfill: existing sessions stay
-- password/legacy provenance until reauthentication. Password sessions write
-- NULL; SSO sessions write the exact linked identity (B3).
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS active_session_auth_identity_id uuid
    REFERENCES student_auth_identities(id);
