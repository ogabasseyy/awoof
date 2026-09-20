-- Consent rows are never deleted, and the owner-history query intentionally
-- includes withdrawn records ordered by (accepted_at DESC, id DESC). The only
-- consent index only serves live rows, so history reads filter and sort the
-- whole retained table on every verification-page visit.
CREATE INDEX microsoft_verification_consents_history_idx
    ON microsoft_verification_consents (user_id, accepted_at DESC, id DESC);

-- Attempt rows are never deleted either. Provider-consent withdrawal, parent
-- processing-grant withdrawal, and owner/institution unlink each fail active
-- attempts by cancellation key while holding authority locks; without
-- active-status indexes those paths scan the global attempt history and
-- block concurrent verification work as history grows.
CREATE INDEX microsoft_verification_attempts_cancel_consent_idx
    ON microsoft_verification_attempts (provider_consent_id)
    WHERE status IN ('pending', 'processing', 'ready');
CREATE INDEX microsoft_verification_attempts_cancel_grant_idx
    ON microsoft_verification_attempts (processing_grant_id)
    WHERE status IN ('pending', 'processing', 'ready');
CREATE INDEX microsoft_verification_attempts_cancel_owner_idx
    ON microsoft_verification_attempts (user_id, university_id)
    WHERE status IN ('pending', 'processing', 'ready');

-- assertMicrosoftAuthority trusts the consent row as the immutable acceptance
-- snapshot, so a direct-SQL rewrite of its version, notice, mode, or scopes
-- (or clearing a withdrawal) could re-authorize attempts without a new
-- acceptance. Freeze every snapshot field and permit only the first
-- null-to-timestamp withdrawal, mirroring microsoft_proof_protect. The only
-- application writer performs exactly that one-way transition.
CREATE OR REPLACE FUNCTION microsoft_consent_protect() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.university_id IS DISTINCT FROM OLD.university_id OR NEW.processing_grant_id IS DISTINCT FROM OLD.processing_grant_id
        OR NEW.provider_policy_version IS DISTINCT FROM OLD.provider_policy_version OR NEW.notice_version IS DISTINCT FROM OLD.notice_version
        OR NEW.mode IS DISTINCT FROM OLD.mode OR NEW.scopes IS DISTINCT FROM OLD.scopes
        OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at OR OLD.withdrawn_at IS NOT NULL OR NEW.withdrawn_at IS NULL THEN
        RAISE EXCEPTION 'Microsoft verification consent is immutable except one-way withdrawal';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER microsoft_consent_before_update
    BEFORE UPDATE ON microsoft_verification_consents FOR EACH ROW EXECUTE FUNCTION microsoft_consent_protect();

-- A cleared revocation (or rewritten ownership) would silently reconnect an
-- identity whose support_required tombstone must never be restored or
-- transferred automatically. Freeze the row and permit only the initial
-- null-to-timestamp revocation, mirroring microsoft_proof_protect. The only
-- application writer performs exactly that one-way transition.
CREATE OR REPLACE FUNCTION microsoft_identity_protect() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.university_id IS DISTINCT FROM OLD.university_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        OR NEW.object_id IS DISTINCT FROM OLD.object_id OR NEW.linked_at IS DISTINCT FROM OLD.linked_at
        OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
        RAISE EXCEPTION 'Microsoft identity is immutable except one-way revocation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER microsoft_identity_before_update
    BEFORE UPDATE ON microsoft_identities FOR EACH ROW EXECUTE FUNCTION microsoft_identity_protect();
