-- The idempotency key only authorizes rebinding a still-pending recovery
-- attempt after a lost start response. Verified and terminal rows must not
-- retain that browser retry secret for the seven-day tombstone lifetime.
UPDATE student_auth_recovery_attempts
SET idempotency_key = NULL
WHERE idempotency_key IS NOT NULL
  AND (status <> 'pending' OR expires_at <= clock_timestamp());
