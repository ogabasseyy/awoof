-- Transactional, bounded OTP challenges. JWT-secret rotation intentionally
-- invalidates outstanding challenges because the stored HMAC digests use it.
CREATE TABLE verification_challenge_budgets (
    purpose VARCHAR(32) NOT NULL CHECK (purpose IN ('student_signup', 'student_email', 'account_email', 'whatsapp', 'password_reset')),
    subject_digest VARCHAR(64) NOT NULL CHECK (char_length(subject_digest) = 64),
    current_challenge_id UUID,
    window_started_at TIMESTAMPTZ NOT NULL,
    failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
    send_count INTEGER NOT NULL DEFAULT 0 CHECK (send_count >= 0),
    resend_available_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (purpose, subject_digest)
);

CREATE TABLE verification_challenges (
    id UUID PRIMARY KEY,
    purpose VARCHAR(32) NOT NULL CHECK (purpose IN ('student_signup', 'student_email', 'account_email', 'whatsapp', 'password_reset')),
    subject_digest VARCHAR(64) NOT NULL CHECK (char_length(subject_digest) = 64),
    secret_digest VARCHAR(64) NOT NULL CHECK (char_length(secret_digest) = 64),
    bindings JSONB NOT NULL CHECK (jsonb_typeof(bindings) = 'object' AND octet_length(bindings::text) <= 8192),
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > created_at),
    consumed_at TIMESTAMPTZ,
    superseded_at TIMESTAMPTZ
);

ALTER TABLE verification_challenge_budgets
    ADD CONSTRAINT verification_challenge_budgets_current_challenge_fk
    FOREIGN KEY (current_challenge_id) REFERENCES verification_challenges(id);

CREATE INDEX verification_challenges_subject_lookup_idx
    ON verification_challenges (purpose, subject_digest, created_at DESC);
CREATE INDEX verification_challenges_expiry_idx
    ON verification_challenges (expires_at)
    WHERE consumed_at IS NULL AND superseded_at IS NULL;
