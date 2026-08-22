-- Migration: Marketplace checkout settlement tracking
BEGIN;

ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS settlement_mode VARCHAR(20)
        CHECK (settlement_mode IN ('split', 'manual'));

-- Prevent duplicate webhook processing for the same Paystack reference
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_paystack_reference_unique
    ON transactions (paystack_reference)
    WHERE paystack_reference IS NOT NULL;

COMMIT;
