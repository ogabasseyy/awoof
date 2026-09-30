-- Cooldown retries rebind the already-emailed OTP to a replacement handle
-- when the first 202 was lost. Without a browser binding, any anonymous
-- caller knowing the victim's email can trigger that replacement during
-- the resend cooldown, silently failing the victim's handle and keeping
-- recovery unavailable with repeated requests. Persist the client's
-- idempotency key on the attempt so a retry only replaces the live
-- attempt when it presents the key from the original start. Nullable:
-- retries that omit the key (or predate this column) fail safe into the
-- frozen-expiry response without touching the live attempt.
ALTER TABLE student_auth_recovery_attempts ADD COLUMN idempotency_key TEXT NULL;
