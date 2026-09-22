-- Task B4: bind reauth grants to the password hash verified at reauth.
--
-- Additive only. A password reset or removal between reauth and link/unlink
-- must fail the grant: the link service compares this binding against the
-- live users row inside the same locked transaction. Legacy rows predate the
-- binding and stay NULL, which never equals a live password hash, so they
-- fail closed. The consume-once writer below pins the new column alongside
-- the existing ones: a consumed grant cannot be rebound.
ALTER TABLE student_auth_reauth_grants
    ADD COLUMN IF NOT EXISTS password_hash text;

CREATE OR REPLACE FUNCTION student_sso_grant_consume_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.consumed_at IS NOT NULL
        AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
            OR NEW.sid IS DISTINCT FROM OLD.sid OR NEW.purpose IS DISTINCT FROM OLD.purpose
            OR NEW.secret_hash IS DISTINCT FROM OLD.secret_hash
            OR NEW.password_hash IS DISTINCT FROM OLD.password_hash
            OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
            OR NEW.consumed_at IS DISTINCT FROM OLD.consumed_at
            OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
        RAISE EXCEPTION 'Consumed reauth grants cannot be reused or rewritten';
    END IF;
    RETURN NEW;
END $$;
