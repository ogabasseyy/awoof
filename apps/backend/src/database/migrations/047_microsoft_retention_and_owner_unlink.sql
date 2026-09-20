-- Retention needs to erase an expired completion receipt without replacing the
-- historical attempt row.  NULL means erased, never a sentinel hash which a
-- caller could mistake for a valid finish secret.
ALTER TABLE microsoft_verification_attempts
    ALTER COLUMN state_hash DROP NOT NULL,
    ALTER COLUMN browser_secret_hash DROP NOT NULL,
    ALTER COLUMN finish_secret_hash DROP NOT NULL;

-- The existing expiry index is sufficient for the terminal/expired attempt
-- selection.  This partial index keeps the bounded cleanup scan selective
-- after providers have completed or cancelled an attempt.
CREATE INDEX microsoft_verification_attempts_retention_idx
    ON microsoft_verification_attempts (expires_at, id)
    WHERE status IN ('completed', 'failed');
