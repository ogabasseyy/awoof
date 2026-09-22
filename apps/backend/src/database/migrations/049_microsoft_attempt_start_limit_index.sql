-- The per-user start guards count recent attempts by owner and creation time
-- (10-minute start window and outstanding-attempt cap). Existing attempt
-- indexes are expiry-oriented, so without a leading (user_id, created_at)
-- index every Microsoft start scans the accumulating global attempt history.
-- Attempt rows are never deleted, so this keeps the verification entrypoint
-- selective as retained history grows.
CREATE INDEX microsoft_verification_attempts_start_limit_idx
    ON microsoft_verification_attempts (user_id, created_at);
