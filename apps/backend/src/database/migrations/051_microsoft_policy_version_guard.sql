-- Direct SQL maintenance can UPDATE institution_microsoft_policies with only
-- `version` set, bypassing the auto-increment in
-- microsoft_policy_validate_and_version and rolling a policy back to an
-- earlier version. A rolled-back version makes an old, unwithdrawn provider
-- consent match assertMicrosoftAuthority again, silently restoring authority
-- that the version bump invalidated. Redefine the trigger function so the
-- version is trigger-owned on every UPDATE: material changes increment from
-- OLD.version (caller-supplied values are ignored) and no-op updates keep
-- OLD.version instead of adopting a caller-supplied rollback.
-- Plain (non-concurrent) DDL matches every other migration here because the
-- migration runner applies each file inside its own transaction, and the
-- existing microsoft_policy_before_write trigger picks up the replacement
-- by function name.
CREATE OR REPLACE FUNCTION microsoft_policy_validate_and_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.enabled AND NEW.mode = 'graph_enrollment' AND (NEW.term_ends_at IS NULL OR NEW.term_ends_at <= clock_timestamp()
        OR NEW.approved_until <= clock_timestamp()) THEN
        RAISE EXCEPTION 'graph Microsoft policy requires a current approval and term boundary';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
            OR NEW.enabled IS DISTINCT FROM OLD.enabled OR NEW.mode IS DISTINCT FROM OLD.mode
            OR NEW.approved_until IS DISTINCT FROM OLD.approved_until OR NEW.term_ends_at IS DISTINCT FROM OLD.term_ends_at
            OR NEW.max_evidence_hours IS DISTINCT FROM OLD.max_evidence_hours OR NEW.scopes IS DISTINCT FROM OLD.scopes
            OR NEW.notice_version IS DISTINCT FROM OLD.notice_version) THEN
            NEW.version := OLD.version + 1;
        ELSE
            NEW.version := OLD.version;
        END IF;
    END IF;
    RETURN NEW;
END $$;
