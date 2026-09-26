-- Repair the 069 terminal transition: consumed action grants must immediately
-- scrub their secret digest, but no live binding may ever be rewritten.
-- 069 made the digest globally unique. A fixed terminal scrub sentinel is
-- deliberately shared, so keep uniqueness for nothing security-relevant:
-- live digest comparison is always scoped by the opaque grant id.
ALTER TABLE student_auth_action_grants
    DROP CONSTRAINT student_auth_action_grants_secret_hash_key;

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
       AND NEW.consumed_at IS NOT NULL AND NEW.revoked_at IS NULL
       AND NEW.secret_hash = 'scrubbed' THEN
        RETURN NEW;
    END IF;
    IF NEW.consumed_at IS DISTINCT FROM OLD.consumed_at
        OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
        OR NEW.secret_hash IS DISTINCT FROM OLD.secret_hash THEN
        RAISE EXCEPTION 'Terminal passwordless action grants cannot be replayed';
    END IF;
    RETURN NEW;
END $$;
