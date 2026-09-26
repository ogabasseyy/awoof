-- Additive credential records for the proposed passwordless-student flow.
--
-- This migration intentionally preserves the canonical SSO policy, identity,
-- attempt, handoff and legacy password-reauth tables. It also follows the
-- existing 067/068 legal-assent migrations rather than renumbering or
-- rewriting them.
--
-- Writers that combine these records with the existing SSO flow must retain
-- its canonical order:
-- users → students → universities → institution_login_policies →
-- student_auth_identities → student_auth_attempts →
-- student_auth_link_handoffs → passwordless action/reauth/recovery state.
-- Account-credential operations hold the user row before their own rows;
-- they never acquire an earlier identity or handoff lock after doing so.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS password_setup_requires_recovery_code boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS recovery_reenrollment_requires_password boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS credential_generation bigint NOT NULL DEFAULT 0
        CHECK (credential_generation >= 0);

CREATE TABLE student_auth_signup_challenges (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    handoff_id uuid NOT NULL UNIQUE REFERENCES student_auth_link_handoffs(id),
    secret_hash text NOT NULL UNIQUE,
    browser_binding_hash text NOT NULL,
    mailbox_challenge_id uuid REFERENCES verification_challenges(id),
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'mailbox_verified', 'consumed', 'cancelled', 'expired')),
    expires_at timestamptz NOT NULL,
    mailbox_verified_at timestamptz,
    consumed_at timestamptz,
    terminal_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (expires_at <= created_at + interval '10 minutes'),
    CHECK (
        (status = 'pending' AND mailbox_verified_at IS NULL AND consumed_at IS NULL AND terminal_at IS NULL)
        OR (status = 'mailbox_verified' AND mailbox_verified_at IS NOT NULL AND consumed_at IS NULL AND terminal_at IS NULL)
        OR (status = 'consumed' AND mailbox_verified_at IS NOT NULL AND consumed_at IS NOT NULL AND terminal_at IS NOT NULL)
        OR (status IN ('cancelled', 'expired') AND consumed_at IS NULL AND terminal_at IS NOT NULL)
    )
);
CREATE INDEX student_auth_signup_challenges_expiry_idx
    ON student_auth_signup_challenges (expires_at) WHERE terminal_at IS NULL;

CREATE OR REPLACE FUNCTION student_passwordless_signup_challenge_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.handoff_id IS DISTINCT FROM OLD.handoff_id
        OR NEW.secret_hash IS DISTINCT FROM OLD.secret_hash
        OR NEW.browser_binding_hash IS DISTINCT FROM OLD.browser_binding_hash
        OR NEW.mailbox_challenge_id IS DISTINCT FROM OLD.mailbox_challenge_id
        OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
        OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Passwordless signup challenge binding is immutable';
    END IF;
    IF OLD.status IN ('consumed', 'cancelled', 'expired') AND NEW.status IS DISTINCT FROM OLD.status THEN
        RAISE EXCEPTION 'Terminal passwordless signup challenges cannot be replayed';
    END IF;
    IF OLD.status = 'pending' AND NEW.status NOT IN ('pending', 'mailbox_verified', 'cancelled', 'expired') THEN
        RAISE EXCEPTION 'Invalid passwordless signup challenge transition';
    END IF;
    IF OLD.status = 'mailbox_verified' AND NEW.status NOT IN ('mailbox_verified', 'consumed', 'cancelled', 'expired') THEN
        RAISE EXCEPTION 'Invalid passwordless signup challenge transition';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER student_passwordless_signup_challenge_before_update
    BEFORE UPDATE ON student_auth_signup_challenges
    FOR EACH ROW EXECUTE FUNCTION student_passwordless_signup_challenge_transition();

CREATE TABLE student_auth_recovery_codes (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id uuid NOT NULL REFERENCES users(id),
    generation bigint NOT NULL CHECK (generation >= 0),
    code_digest text,
    status text NOT NULL CHECK (status IN ('pending', 'active', 'consumed', 'revoked')),
    expires_at timestamptz,
    activated_at timestamptz,
    consumed_at timestamptz,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (user_id, generation),
    UNIQUE (id, user_id),
    CHECK (
        (status = 'pending' AND code_digest IS NOT NULL AND expires_at IS NOT NULL
            AND expires_at <= created_at + interval '10 minutes'
            AND activated_at IS NULL AND consumed_at IS NULL AND revoked_at IS NULL)
        OR (status = 'active' AND code_digest IS NOT NULL AND expires_at IS NULL
            AND activated_at IS NOT NULL AND consumed_at IS NULL AND revoked_at IS NULL)
        OR (status = 'consumed' AND expires_at IS NULL AND consumed_at IS NOT NULL AND revoked_at IS NULL)
        OR (status = 'revoked' AND expires_at IS NULL AND consumed_at IS NULL AND revoked_at IS NOT NULL)
    )
);
CREATE UNIQUE INDEX student_auth_recovery_codes_one_active_owner_idx
    ON student_auth_recovery_codes (user_id) WHERE status = 'active';
CREATE INDEX student_auth_recovery_codes_expiry_idx
    ON student_auth_recovery_codes (expires_at) WHERE status = 'pending';

CREATE OR REPLACE FUNCTION student_passwordless_recovery_code_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.generation IS DISTINCT FROM OLD.generation OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Recovery-code ownership is immutable';
    END IF;
    IF OLD.status IN ('consumed', 'revoked') AND NEW.status IS DISTINCT FROM OLD.status THEN
        RAISE EXCEPTION 'Terminal recovery codes cannot be replayed';
    END IF;
    IF OLD.status = 'pending' AND NEW.status NOT IN ('pending', 'active', 'revoked') THEN
        RAISE EXCEPTION 'Invalid recovery-code transition';
    END IF;
    IF OLD.status = 'active' AND NEW.status NOT IN ('active', 'consumed', 'revoked') THEN
        RAISE EXCEPTION 'Invalid recovery-code transition';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER student_passwordless_recovery_code_before_update
    BEFORE UPDATE ON student_auth_recovery_codes
    FOR EACH ROW EXECUTE FUNCTION student_passwordless_recovery_code_transition();

CREATE TABLE student_auth_action_grants (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id uuid NOT NULL REFERENCES users(id),
    sid uuid NOT NULL,
    credential_generation bigint NOT NULL CHECK (credential_generation >= 0),
    purpose text NOT NULL CHECK (purpose IN (
        'link', 'unlink', 'recovery_code_generate', 'recovery_code_activate', 'recovery_code_remove'
    )),
    secret_hash text NOT NULL UNIQUE,
    proof_identity_id uuid,
    target_identity_id uuid,
    pending_code_id uuid,
    active_code_generation bigint CHECK (active_code_generation >= 0),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (proof_identity_id, user_id) REFERENCES student_auth_identities(id, user_id),
    FOREIGN KEY (target_identity_id, user_id) REFERENCES student_auth_identities(id, user_id),
    FOREIGN KEY (pending_code_id, user_id) REFERENCES student_auth_recovery_codes(id, user_id),
    FOREIGN KEY (user_id, active_code_generation) REFERENCES student_auth_recovery_codes(user_id, generation),
    CHECK (expires_at <= created_at + interval '5 minutes'),
    CHECK (NOT (consumed_at IS NOT NULL AND revoked_at IS NOT NULL))
);
CREATE INDEX student_auth_action_grants_owner_expiry_idx
    ON student_auth_action_grants (user_id, expires_at) WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE OR REPLACE FUNCTION student_passwordless_action_grant_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.sid IS DISTINCT FROM OLD.sid OR NEW.credential_generation IS DISTINCT FROM OLD.credential_generation
        OR NEW.purpose IS DISTINCT FROM OLD.purpose OR NEW.secret_hash IS DISTINCT FROM OLD.secret_hash
        OR NEW.proof_identity_id IS DISTINCT FROM OLD.proof_identity_id
        OR NEW.target_identity_id IS DISTINCT FROM OLD.target_identity_id
        OR NEW.pending_code_id IS DISTINCT FROM OLD.pending_code_id
        OR NEW.active_code_generation IS DISTINCT FROM OLD.active_code_generation
        OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Passwordless action-grant binding is immutable';
    END IF;
    IF (OLD.consumed_at IS NOT NULL OR OLD.revoked_at IS NOT NULL)
        AND (NEW.consumed_at IS DISTINCT FROM OLD.consumed_at OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
        RAISE EXCEPTION 'Terminal passwordless action grants cannot be replayed';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER student_passwordless_action_grant_before_update
    BEFORE UPDATE ON student_auth_action_grants
    FOR EACH ROW EXECUTE FUNCTION student_passwordless_action_grant_transition();

CREATE TABLE student_auth_reauth_attempts (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id uuid NOT NULL REFERENCES users(id),
    sid uuid NOT NULL,
    credential_generation bigint NOT NULL CHECK (credential_generation >= 0),
    purpose text NOT NULL CHECK (purpose IN (
        'link', 'unlink', 'recovery_code_generate', 'recovery_code_activate', 'recovery_code_remove'
    )),
    policy_id uuid REFERENCES institution_login_policies(id),
    policy_version integer CHECK (policy_version >= 1),
    provider text CHECK (provider IN ('google', 'microsoft')),
    state_hash text UNIQUE,
    callback_cookie_hash text,
    encrypted_verifier text,
    nonce text,
    proof_identity_id uuid,
    target_identity_id uuid,
    pending_code_id uuid,
    active_code_generation bigint CHECK (active_code_generation >= 0),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'consumed', 'failed')),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (proof_identity_id, user_id) REFERENCES student_auth_identities(id, user_id),
    FOREIGN KEY (target_identity_id, user_id) REFERENCES student_auth_identities(id, user_id),
    FOREIGN KEY (pending_code_id, user_id) REFERENCES student_auth_recovery_codes(id, user_id),
    FOREIGN KEY (user_id, active_code_generation) REFERENCES student_auth_recovery_codes(user_id, generation),
    CHECK (expires_at <= created_at + interval '10 minutes'),
    CHECK ((policy_id IS NULL) = (policy_version IS NULL)),
    CHECK ((provider IS NULL) = (policy_id IS NULL)),
    CHECK (status <> 'pending' OR (state_hash IS NOT NULL AND callback_cookie_hash IS NOT NULL
        AND encrypted_verifier IS NOT NULL AND nonce IS NOT NULL)),
    CHECK (status <> 'ready' OR proof_identity_id IS NOT NULL),
    CHECK (status NOT IN ('consumed', 'failed') OR consumed_at IS NOT NULL)
);
CREATE INDEX student_auth_reauth_attempts_owner_expiry_idx
    ON student_auth_reauth_attempts (user_id, expires_at) WHERE status IN ('pending', 'ready');

CREATE OR REPLACE FUNCTION student_passwordless_reauth_attempt_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.sid IS DISTINCT FROM OLD.sid OR NEW.credential_generation IS DISTINCT FROM OLD.credential_generation
        OR NEW.purpose IS DISTINCT FROM OLD.purpose OR NEW.policy_id IS DISTINCT FROM OLD.policy_id
        OR NEW.policy_version IS DISTINCT FROM OLD.policy_version OR NEW.provider IS DISTINCT FROM OLD.provider
        OR NEW.state_hash IS DISTINCT FROM OLD.state_hash OR NEW.callback_cookie_hash IS DISTINCT FROM OLD.callback_cookie_hash
        OR NEW.encrypted_verifier IS DISTINCT FROM OLD.encrypted_verifier OR NEW.nonce IS DISTINCT FROM OLD.nonce
        OR NEW.target_identity_id IS DISTINCT FROM OLD.target_identity_id
        OR NEW.pending_code_id IS DISTINCT FROM OLD.pending_code_id
        OR NEW.active_code_generation IS DISTINCT FROM OLD.active_code_generation
        OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Passwordless reauthentication attempt binding is immutable';
    END IF;
    IF OLD.status IN ('consumed', 'failed') AND NEW.status IS DISTINCT FROM OLD.status THEN
        RAISE EXCEPTION 'Terminal passwordless reauthentication attempts cannot be replayed';
    END IF;
    IF OLD.status = 'pending' AND NEW.status NOT IN ('pending', 'ready', 'failed') THEN
        RAISE EXCEPTION 'Invalid passwordless reauthentication attempt transition';
    END IF;
    IF OLD.status = 'ready' AND NEW.status NOT IN ('ready', 'consumed', 'failed') THEN
        RAISE EXCEPTION 'Invalid passwordless reauthentication attempt transition';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER student_passwordless_reauth_attempt_before_update
    BEFORE UPDATE ON student_auth_reauth_attempts
    FOR EACH ROW EXECUTE FUNCTION student_passwordless_reauth_attempt_transition();

CREATE TABLE student_auth_recovery_attempts (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id uuid NOT NULL REFERENCES users(id),
    credential_generation bigint NOT NULL CHECK (credential_generation >= 0),
    purpose text NOT NULL CHECK (purpose IN ('lost_access', 'compromise')),
    secret_hash text NOT NULL UNIQUE,
    recovery_code_generation bigint NOT NULL CHECK (recovery_code_generation >= 0),
    mailbox_challenge_id uuid REFERENCES verification_challenges(id),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'consumed', 'failed', 'expired')),
    expires_at timestamptz NOT NULL,
    verified_at timestamptz,
    consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (user_id, recovery_code_generation) REFERENCES student_auth_recovery_codes(user_id, generation),
    CHECK (expires_at <= created_at + interval '10 minutes'),
    CHECK (
        (status = 'pending' AND verified_at IS NULL AND consumed_at IS NULL)
        OR (status = 'verified' AND verified_at IS NOT NULL AND consumed_at IS NULL)
        OR (status = 'consumed' AND verified_at IS NOT NULL AND consumed_at IS NOT NULL)
        OR (status IN ('failed', 'expired') AND consumed_at IS NULL)
    )
);
CREATE INDEX student_auth_recovery_attempts_owner_expiry_idx
    ON student_auth_recovery_attempts (user_id, expires_at) WHERE status IN ('pending', 'verified');

CREATE OR REPLACE FUNCTION student_passwordless_recovery_attempt_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.credential_generation IS DISTINCT FROM OLD.credential_generation
        OR NEW.purpose IS DISTINCT FROM OLD.purpose OR NEW.secret_hash IS DISTINCT FROM OLD.secret_hash
        OR NEW.recovery_code_generation IS DISTINCT FROM OLD.recovery_code_generation
        OR NEW.mailbox_challenge_id IS DISTINCT FROM OLD.mailbox_challenge_id
        OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Passwordless recovery attempt binding is immutable';
    END IF;
    IF OLD.status IN ('consumed', 'failed', 'expired') AND NEW.status IS DISTINCT FROM OLD.status THEN
        RAISE EXCEPTION 'Terminal passwordless recovery attempts cannot be replayed';
    END IF;
    IF OLD.status = 'pending' AND NEW.status NOT IN ('pending', 'verified', 'failed', 'expired') THEN
        RAISE EXCEPTION 'Invalid passwordless recovery attempt transition';
    END IF;
    IF OLD.status = 'verified' AND NEW.status NOT IN ('verified', 'consumed', 'failed', 'expired') THEN
        RAISE EXCEPTION 'Invalid passwordless recovery attempt transition';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER student_passwordless_recovery_attempt_before_update
    BEFORE UPDATE ON student_auth_recovery_attempts
    FOR EACH ROW EXECUTE FUNCTION student_passwordless_recovery_attempt_transition();
