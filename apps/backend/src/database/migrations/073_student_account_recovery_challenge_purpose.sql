-- Independent account recovery has an OTP budget distinct from legacy
-- password reset and passwordless signup. Its attempt row binds the OTP to
-- a fixed recovery purpose; this migration only admits that isolated purpose.
ALTER TABLE verification_challenges DROP CONSTRAINT verification_challenges_purpose_check;
ALTER TABLE verification_challenges ADD CONSTRAINT verification_challenges_purpose_check
    CHECK (purpose IN ('student_signup', 'student_sso_signup', 'student_account_recovery', 'student_email', 'account_email', 'whatsapp', 'password_reset'));

ALTER TABLE verification_challenge_budgets DROP CONSTRAINT verification_challenge_budgets_purpose_check;
ALTER TABLE verification_challenge_budgets ADD CONSTRAINT verification_challenge_budgets_purpose_check
    CHECK (purpose IN ('student_signup', 'student_sso_signup', 'student_account_recovery', 'student_email', 'account_email', 'whatsapp', 'password_reset'));
