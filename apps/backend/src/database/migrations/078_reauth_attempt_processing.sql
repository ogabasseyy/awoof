-- Let reauthentication callbacks claim a processing state before redeeming
-- the one-use provider authorization code, mirroring the ordinary SSO
-- callback. Without the claim, a concurrently delivered duplicate callback
-- redeems twice: the losing redemption is handled as a terminal OIDC
-- failure and can mark the attempt failed while the winner is still in
-- flight. The claim flips pending to processing; redemption success flips
-- to ready, and any failure reverts to pending so the route layer keeps
-- sole ownership of terminalization. Expiry cleanup and recovery
-- invalidation reap processing rows exactly like other live rows.
ALTER TABLE student_auth_reauth_attempts
    DROP CONSTRAINT student_auth_reauth_attempts_status_check;
ALTER TABLE student_auth_reauth_attempts
    ADD CONSTRAINT student_auth_reauth_attempts_status_check
    CHECK (status IN ('pending', 'processing', 'ready', 'consumed', 'failed'));

DROP INDEX IF EXISTS student_auth_reauth_attempts_owner_expiry_idx;
CREATE INDEX student_auth_reauth_attempts_owner_expiry_idx
    ON student_auth_reauth_attempts (user_id, expires_at) WHERE status IN ('pending', 'processing', 'ready');

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
    IF OLD.status = 'pending' AND NEW.status NOT IN ('pending', 'processing', 'ready', 'failed') THEN
        RAISE EXCEPTION 'Invalid passwordless reauthentication attempt transition';
    END IF;
    IF OLD.status = 'processing' AND NEW.status NOT IN ('processing', 'pending', 'ready', 'failed') THEN
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
