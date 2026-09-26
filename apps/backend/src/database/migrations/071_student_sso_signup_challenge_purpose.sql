-- Keep the passwordless SSO mailbox proof independent from legacy student
-- registration budgets and expiries.  The new purpose has its own digest key.
ALTER TABLE verification_challenges DROP CONSTRAINT verification_challenges_purpose_check;
ALTER TABLE verification_challenges ADD CONSTRAINT verification_challenges_purpose_check
    CHECK (purpose IN ('student_signup', 'student_sso_signup', 'student_email', 'account_email', 'whatsapp', 'password_reset'));
ALTER TABLE verification_challenge_budgets DROP CONSTRAINT verification_challenge_budgets_purpose_check;
ALTER TABLE verification_challenge_budgets ADD CONSTRAINT verification_challenge_budgets_purpose_check
    CHECK (purpose IN ('student_signup', 'student_sso_signup', 'student_email', 'account_email', 'whatsapp', 'password_reset'));

-- 069 stays immutable as originally shipped. A passwordless OTP is issued
-- after its handoff context exists, so permit only pending-state replacement
-- of its challenge reference; all secret/browser/handoff/expiry fields and
-- every terminal state remain immutable.
CREATE OR REPLACE FUNCTION student_passwordless_signup_challenge_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.handoff_id IS DISTINCT FROM OLD.handoff_id
        OR NEW.secret_hash IS DISTINCT FROM OLD.secret_hash
        OR NEW.browser_binding_hash IS DISTINCT FROM OLD.browser_binding_hash
        OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
        OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Passwordless signup challenge binding is immutable';
    END IF;
    IF OLD.status <> 'pending' AND NEW.mailbox_challenge_id IS DISTINCT FROM OLD.mailbox_challenge_id THEN
        RAISE EXCEPTION 'Passwordless signup challenge binding is immutable';
    END IF;
    IF OLD.status IN ('consumed', 'cancelled', 'expired') AND NEW.status IS DISTINCT FROM OLD.status THEN
        RAISE EXCEPTION 'Terminal passwordless signup challenges cannot be replayed';
    END IF;
    IF OLD.status = 'pending' AND NEW.status NOT IN ('pending', 'mailbox_verified', 'cancelled', 'expired') THEN
        RAISE EXCEPTION 'Invalid passwordless signup challenge transition';
    END IF;
    IF OLD.status = 'mailbox_verified' AND NEW.status NOT IN ('mailbox_verified', 'consumed', 'cancelled', 'expired') THEN
        RAISE EXCEPTION 'Invalid passwordless signup challenge transition';
    END IF;
    RETURN NEW;
END $$;
