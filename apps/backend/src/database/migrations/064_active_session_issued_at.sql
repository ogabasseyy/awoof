-- Task review-loop: record when the user's current server session was
-- issued so SSO finish can yield to a concurrent sign-in.
--
-- Additive only: nullable timestamp, unset for every existing row. New
-- sessions stamp it at issuance; session-clearing flows reset it to NULL
-- alongside the session id.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS active_session_issued_at timestamptz NULL;
