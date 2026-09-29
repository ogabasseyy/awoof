-- Account recovery and deployment invalidate provider login attempts that
-- began before the boundary, including attempts using an approved alias
-- mailbox. Initialize existing users at migration time to fail closed for
-- attempts created by an older backend; later recoveries advance the fence.
ALTER TABLE users
    ADD COLUMN student_sso_attempts_not_before timestamptz;

UPDATE users SET student_sso_attempts_not_before = clock_timestamp();

COMMENT ON COLUMN users.student_sso_attempts_not_before IS
    'Database-time fence used to reject SSO attempts created before the deployment or most recent successful account recovery.';
