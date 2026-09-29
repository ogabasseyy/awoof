-- Active recovery codes must not retain the pending-only authorization
-- bindings. pending_sid, pending_credential_generation, and
-- pending_proof_identity_id authorize only the pending activation; once the
-- durable code is active they are unnecessary session and proof-identity
-- metadata. Permit exactly one one-way transition (pending-to-active with all
-- three bindings nulled, plus the same scrub applied to already-active rows),
-- backfill existing active rows, and enforce the scrubbed shape going forward.
CREATE OR REPLACE FUNCTION student_passwordless_recovery_code_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.pending_sid IS DISTINCT FROM OLD.pending_sid
        OR NEW.pending_credential_generation IS DISTINCT FROM OLD.pending_credential_generation
        OR NEW.pending_proof_identity_id IS DISTINCT FROM OLD.pending_proof_identity_id)
        AND NOT (NEW.pending_sid IS NULL AND NEW.pending_credential_generation IS NULL
                 AND NEW.pending_proof_identity_id IS NULL
                 AND NEW.status = 'active' AND OLD.status IN ('pending', 'active')) THEN
        RAISE EXCEPTION 'Recovery-code ownership is immutable';
    END IF;
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

UPDATE student_auth_recovery_codes
SET pending_sid = NULL,
    pending_credential_generation = NULL,
    pending_proof_identity_id = NULL
WHERE status = 'active'
  AND (pending_sid IS NOT NULL OR pending_credential_generation IS NOT NULL OR pending_proof_identity_id IS NOT NULL);

ALTER TABLE student_auth_recovery_codes
    ADD CONSTRAINT student_auth_recovery_codes_active_binding_scrubbed_check CHECK (
        status <> 'active'
        OR (pending_sid IS NULL AND pending_credential_generation IS NULL AND pending_proof_identity_id IS NULL)
    );
