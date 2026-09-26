-- Keep the passwordless SSO mailbox proof independent from legacy student
-- registration budgets and expiries.  The new purpose has its own digest key.
ALTER TABLE verification_challenges DROP CONSTRAINT verification_challenges_purpose_check;
ALTER TABLE verification_challenges ADD CONSTRAINT verification_challenges_purpose_check
    CHECK (purpose IN ('student_signup', 'student_sso_signup', 'student_email', 'account_email', 'whatsapp', 'password_reset'));
ALTER TABLE verification_challenge_budgets DROP CONSTRAINT verification_challenge_budgets_purpose_check;
ALTER TABLE verification_challenge_budgets ADD CONSTRAINT verification_challenge_budgets_purpose_check
    CHECK (purpose IN ('student_signup', 'student_sso_signup', 'student_email', 'account_email', 'whatsapp', 'password_reset'));
