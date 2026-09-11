ALTER TABLE payment_reconciliation_queue DROP CONSTRAINT payment_reconciliation_queue_reason_check;
ALTER TABLE payment_reconciliation_queue ADD CONSTRAINT payment_reconciliation_queue_reason_check
    CHECK (reason IN ('stock_unavailable', 'amount_mismatch', 'eligibility_not_current'));
