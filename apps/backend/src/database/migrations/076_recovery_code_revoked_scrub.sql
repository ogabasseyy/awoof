-- Revoked recovery codes must not retain the pending-only authorization
-- bindings either. Migration 075 scrubbed active rows; terminalization
-- (cancel, supersede, remove, account-recovery consumption, expiry cleanup)
-- now nulls pending_sid, pending_credential_generation, and
-- pending_proof_identity_id alongside the digest. Permit exactly that
-- one-way scrub for revoked rows too, backfill existing revoked and
-- consumed rows, and enforce the scrubbed shape going forward. Consumed
-- rows originate only from scrubbed active rows, but the backfill covers
-- them defensively — and the transition must permit consumed-to-consumed
-- nulling first, or the backfill aborts on the very rows it targets.
CREATE OR REPLACE FUNCTION student_passwordless_recovery_code_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.pending_sid IS DISTINCT FROM OLD.pending_sid
        OR NEW.pending_credential_generation IS DISTINCT FROM OLD.pending_credential_generation
        OR NEW.pending_proof_identity_id IS DISTINCT FROM OLD.pending_proof_identity_id)
        AND NOT (NEW.pending_sid IS NULL AND NEW.pending_credential_generation IS NULL
                 AND NEW.pending_proof_identity_id IS NULL
                 AND ((NEW.status IN ('active', 'revoked') AND OLD.status IN ('pending', 'active', 'revoked'))
                      OR (NEW.status = 'consumed' AND OLD.status = 'consumed'))) THEN
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
WHERE status IN ('revoked', 'consumed')
  AND (pending_sid IS NOT NULL OR pending_credential_generation IS NOT NULL OR pending_proof_identity_id IS NOT NULL);

ALTER TABLE student_auth_recovery_codes
    ADD CONSTRAINT student_auth_recovery_codes_revoked_binding_scrubbed_check CHECK (
        status <> 'revoked'
        OR (pending_sid IS NULL AND pending_credential_generation IS NULL AND pending_proof_identity_id IS NULL)
    );
