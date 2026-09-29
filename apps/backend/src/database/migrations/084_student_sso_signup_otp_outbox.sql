-- Extend the already-deployed recovery-only OTP outbox for passwordless SSO
-- signup. 083 remains immutable; existing rows are backfilled as recovery.
-- Purpose is authenticated by AES-GCM and selects a purpose-specific
-- recipient validator and mail template. The key is never sufficient on its
-- own to cross the recovery/signup boundary.
ALTER TABLE student_account_recovery_otp_outbox
    ADD COLUMN purpose text NOT NULL DEFAULT 'student_account_recovery';

ALTER TABLE student_account_recovery_otp_outbox
    ADD CONSTRAINT student_email_otp_outbox_purpose_check
    CHECK (purpose IN ('student_account_recovery', 'student_sso_signup'));

ALTER TABLE student_account_recovery_otp_outbox
    RENAME TO student_email_otp_outbox;

ALTER INDEX student_recovery_otp_outbox_pending_idx RENAME TO student_email_otp_outbox_pending_idx;
ALTER INDEX student_recovery_otp_outbox_lease_idx RENAME TO student_email_otp_outbox_lease_idx;
ALTER INDEX student_recovery_otp_outbox_retention_idx RENAME TO student_email_otp_outbox_retention_idx;
