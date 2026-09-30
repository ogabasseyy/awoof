-- Persist recovery OTP delivery work atomically with the recovery attempt.
-- OTP plaintext is never stored: ciphertext is AES-256-GCM encrypted by the
-- application, and terminal rows retain only a short-lived secret-free tombstone.
CREATE TABLE student_account_recovery_otp_outbox (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    challenge_id uuid NOT NULL UNIQUE REFERENCES verification_challenges(id) ON DELETE CASCADE,
    key_id varchar(16),
    ciphertext bytea,
    nonce bytea CHECK (nonce IS NULL OR octet_length(nonce) = 12),
    auth_tag bytea CHECK (auth_tag IS NULL OR octet_length(auth_tag) = 16),
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'sent', 'cancelled', 'failed', 'expired')),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    lease_until timestamptz,
    claim_token uuid,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    sent_at timestamptz,
    terminal_at timestamptz,
    CHECK ((status = 'processing' AND lease_until IS NOT NULL AND claim_token IS NOT NULL)
        OR (status <> 'processing' AND lease_until IS NULL AND claim_token IS NULL)),
    CHECK ((ciphertext IS NULL) = (nonce IS NULL)),
    CHECK ((ciphertext IS NULL) = (auth_tag IS NULL)),
    CHECK ((ciphertext IS NULL) = (key_id IS NULL)),
    CHECK (status IN ('sent', 'cancelled', 'failed', 'expired') OR ciphertext IS NOT NULL),
    CHECK (status NOT IN ('sent', 'cancelled', 'failed', 'expired') OR ciphertext IS NULL),
    CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
    CHECK ((status IN ('sent', 'cancelled', 'failed', 'expired')) = (terminal_at IS NOT NULL)),
    CHECK (expires_at > created_at)
);

CREATE INDEX student_recovery_otp_outbox_pending_idx
    ON student_account_recovery_otp_outbox (next_attempt_at, created_at)
    WHERE status = 'pending';
CREATE INDEX student_recovery_otp_outbox_lease_idx
    ON student_account_recovery_otp_outbox (lease_until)
    WHERE status = 'processing';
CREATE INDEX student_recovery_otp_outbox_retention_idx
    ON student_account_recovery_otp_outbox (terminal_at)
    WHERE terminal_at IS NOT NULL;
