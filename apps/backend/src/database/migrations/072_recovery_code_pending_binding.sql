-- Pending recovery codes are authorization state, not merely a secret digest.
-- Bind them to the generating session, credential generation, and proof
-- identity so a later sign-in cannot revive a code generated before logout,
-- a password change, or identity revocation.
ALTER TABLE student_auth_recovery_codes
    ADD COLUMN pending_sid uuid,
    ADD COLUMN pending_credential_generation bigint,
    ADD COLUMN pending_proof_identity_id uuid;

-- Old deployments could have left an unbound pending record. It cannot safely
-- become active after this migration; terminalize and scrub it while retaining
-- a minimal tombstone. Existing active records remain unchanged.
UPDATE student_auth_recovery_codes
SET status = 'revoked',
    code_digest = NULL,
    expires_at = NULL,
    revoked_at = clock_timestamp()
WHERE status = 'pending';

ALTER TABLE student_auth_recovery_codes
    ADD CONSTRAINT student_auth_recovery_codes_pending_binding_check CHECK (
        (status = 'pending'
            AND pending_sid IS NOT NULL
            AND pending_credential_generation IS NOT NULL)
        OR status <> 'pending'
    ),
    ADD CONSTRAINT student_auth_recovery_codes_pending_credential_generation_check CHECK (
        pending_credential_generation IS NULL OR pending_credential_generation >= 0
    ),
    ADD CONSTRAINT student_auth_recovery_codes_pending_identity_owner_fk
        FOREIGN KEY (pending_proof_identity_id, user_id)
        REFERENCES student_auth_identities (id, user_id);

CREATE OR REPLACE FUNCTION student_passwordless_recovery_code_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.generation IS DISTINCT FROM OLD.generation OR NEW.created_at IS DISTINCT FROM OLD.created_at
        OR NEW.pending_sid IS DISTINCT FROM OLD.pending_sid
        OR NEW.pending_credential_generation IS DISTINCT FROM OLD.pending_credential_generation
        OR NEW.pending_proof_identity_id IS DISTINCT FROM OLD.pending_proof_identity_id THEN
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
