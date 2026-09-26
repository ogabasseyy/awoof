-- Bound passwordless transient retention without touching durable identities,
-- account credentials, assertions, or legal records. Terminal rows retain
-- only the identifiers and outcome timestamps needed to reject replay.

ALTER TABLE student_auth_attempts
    ALTER COLUMN state_hash DROP NOT NULL,
    ALTER COLUMN callback_cookie_hash DROP NOT NULL,
    ALTER COLUMN finish_secret_hash DROP NOT NULL;
ALTER TABLE student_auth_link_handoffs
    ALTER COLUMN secret_hash DROP NOT NULL,
    ALTER COLUMN encrypted_observation DROP NOT NULL,
    ALTER COLUMN browser_binding_hash DROP NOT NULL;
ALTER TABLE student_auth_signup_challenges
    ALTER COLUMN secret_hash DROP NOT NULL,
    ALTER COLUMN browser_binding_hash DROP NOT NULL;
ALTER TABLE student_auth_reauth_attempts
    ALTER COLUMN state_hash DROP NOT NULL,
    ALTER COLUMN callback_cookie_hash DROP NOT NULL;
ALTER TABLE student_auth_recovery_attempts
    ALTER COLUMN secret_hash DROP NOT NULL;
ALTER TABLE student_auth_recovery_codes
    ADD COLUMN IF NOT EXISTS terminal_at timestamptz;

CREATE OR REPLACE FUNCTION student_passwordless_signup_challenge_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.handoff_id IS DISTINCT FROM OLD.handoff_id
        OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Passwordless signup challenge binding is immutable';
    END IF;
    IF OLD.status IN ('consumed', 'cancelled', 'expired') AND NEW.status IS DISTINCT FROM OLD.status THEN
        RAISE EXCEPTION 'Terminal passwordless signup challenges cannot be replayed';
    END IF;
    IF OLD.status <> 'pending' AND NEW.mailbox_challenge_id IS DISTINCT FROM OLD.mailbox_challenge_id THEN
        RAISE EXCEPTION 'Passwordless signup challenge binding is immutable';
    END IF;
    IF OLD.status = 'pending' AND NEW.status NOT IN ('pending', 'mailbox_verified', 'cancelled', 'expired') THEN
        RAISE EXCEPTION 'Invalid passwordless signup challenge transition';
    END IF;
    IF OLD.status = 'mailbox_verified' AND NEW.status NOT IN ('mailbox_verified', 'consumed', 'cancelled', 'expired') THEN
        RAISE EXCEPTION 'Invalid passwordless signup challenge transition';
    END IF;
    IF (NEW.secret_hash IS DISTINCT FROM OLD.secret_hash OR NEW.browser_binding_hash IS DISTINCT FROM OLD.browser_binding_hash)
        AND NOT (NEW.secret_hash IS NULL AND NEW.browser_binding_hash IS NULL AND NEW.status IN ('consumed', 'cancelled', 'expired')) THEN
        RAISE EXCEPTION 'Passwordless signup challenge secrets may only be scrubbed at terminalization';
    END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION student_passwordless_action_grant_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.sid IS DISTINCT FROM OLD.sid OR NEW.credential_generation IS DISTINCT FROM OLD.credential_generation
        OR NEW.purpose IS DISTINCT FROM OLD.purpose OR NEW.proof_identity_id IS DISTINCT FROM OLD.proof_identity_id
        OR NEW.target_identity_id IS DISTINCT FROM OLD.target_identity_id
        OR NEW.pending_code_id IS DISTINCT FROM OLD.pending_code_id
        OR NEW.active_code_generation IS DISTINCT FROM OLD.active_code_generation
        OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Passwordless action-grant binding is immutable';
    END IF;
    IF OLD.consumed_at IS NULL AND OLD.revoked_at IS NULL
       AND NEW.secret_hash = 'scrubbed'
       AND ((NEW.consumed_at IS NOT NULL AND NEW.revoked_at IS NULL)
            OR (NEW.revoked_at IS NOT NULL AND NEW.consumed_at IS NULL)) THEN
        RETURN NEW;
    END IF;
    IF NEW.consumed_at IS DISTINCT FROM OLD.consumed_at
        OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
        OR NEW.secret_hash IS DISTINCT FROM OLD.secret_hash THEN
        RAISE EXCEPTION 'Terminal passwordless action grants cannot be replayed';
    END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION student_passwordless_reauth_attempt_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.sid IS DISTINCT FROM OLD.sid OR NEW.credential_generation IS DISTINCT FROM OLD.credential_generation
        OR NEW.purpose IS DISTINCT FROM OLD.purpose OR NEW.policy_id IS DISTINCT FROM OLD.policy_id
        OR NEW.policy_version IS DISTINCT FROM OLD.policy_version OR NEW.provider IS DISTINCT FROM OLD.provider
        OR NEW.proof_identity_id IS DISTINCT FROM OLD.proof_identity_id
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
    IF (NEW.state_hash IS DISTINCT FROM OLD.state_hash OR NEW.callback_cookie_hash IS DISTINCT FROM OLD.callback_cookie_hash
        OR NEW.encrypted_verifier IS DISTINCT FROM OLD.encrypted_verifier OR NEW.nonce IS DISTINCT FROM OLD.nonce)
        AND NOT (NEW.state_hash IS NULL AND NEW.callback_cookie_hash IS NULL AND NEW.encrypted_verifier IS NULL AND NEW.nonce IS NULL
                 AND NEW.status IN ('consumed', 'failed')) THEN
        RAISE EXCEPTION 'Passwordless reauthentication secrets may only be scrubbed at terminalization';
    END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION student_passwordless_recovery_attempt_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.credential_generation IS DISTINCT FROM OLD.credential_generation
        OR NEW.purpose IS DISTINCT FROM OLD.purpose
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
    IF NEW.secret_hash IS DISTINCT FROM OLD.secret_hash
        AND NOT (NEW.secret_hash IS NULL AND NEW.status IN ('consumed', 'failed', 'expired')) THEN
        RAISE EXCEPTION 'Passwordless recovery attempt secret may only be scrubbed at terminalization';
    END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION student_sso_handoff_consume_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
        OR NEW.policy_id IS DISTINCT FROM OLD.policy_id OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
        OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'SSO handoff binding is immutable';
    END IF;
    -- The one legitimate binding transition is the canonical link consume:
    -- an unbound, unconsumed handoff records its owner/session exactly once.
    IF (NEW.target_user_id IS DISTINCT FROM OLD.target_user_id OR NEW.target_sid IS DISTINCT FROM OLD.target_sid)
       AND NOT (OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL
                AND OLD.target_user_id IS NULL AND OLD.target_sid IS NULL
                AND NEW.target_user_id IS NOT NULL AND NEW.target_sid IS NOT NULL) THEN
        RAISE EXCEPTION 'SSO handoff binding is immutable';
    END IF;
    IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
        RAISE EXCEPTION 'Consumed SSO handoffs cannot be replayed';
    END IF;
    IF (NEW.secret_hash IS DISTINCT FROM OLD.secret_hash OR NEW.browser_binding_hash IS DISTINCT FROM OLD.browser_binding_hash)
        AND NOT (NEW.secret_hash IS NULL AND NEW.browser_binding_hash IS NULL
                 AND NEW.encrypted_observation IS NULL
                 AND (NEW.consumed_at IS NOT NULL OR NEW.expires_at <= clock_timestamp())) THEN
        RAISE EXCEPTION 'SSO handoff secrets may only be scrubbed after terminalization';
    END IF;
    IF NEW.encrypted_observation IS DISTINCT FROM OLD.encrypted_observation
       AND NOT (NEW.encrypted_observation = 'scrubbed' AND (NEW.consumed_at IS NOT NULL OR NEW.expires_at <= clock_timestamp()))
       AND NOT (NEW.encrypted_observation IS NULL AND NEW.secret_hash IS NULL AND NEW.browser_binding_hash IS NULL
                AND (NEW.consumed_at IS NOT NULL OR NEW.expires_at <= clock_timestamp())) THEN
        RAISE EXCEPTION 'SSO handoff observation may only be scrubbed after terminalization';
    END IF;
    RETURN NEW;
END $$;
