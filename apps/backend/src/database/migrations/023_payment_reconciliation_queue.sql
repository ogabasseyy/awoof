-- Preserve successful charges that cannot be fulfilled for operator reconciliation.
BEGIN;

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_status_check;
ALTER TABLE transactions
    ADD CONSTRAINT transactions_status_check
    CHECK (status IN ('pending', 'completed', 'failed', 'refunded', 'requires_refund'));

CREATE TABLE IF NOT EXISTS payment_reconciliation_queue (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    transaction_id UUID NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE RESTRICT,
    paystack_reference VARCHAR(255) NOT NULL,
    paid_amount DECIMAL(10, 2) NOT NULL CHECK (paid_amount >= 0),
    reason VARCHAR(50) NOT NULL CHECK (reason IN ('stock_unavailable')),
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'resolved')),
    resolution_note TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_payment_reconciliation_queue_pending
    ON payment_reconciliation_queue (created_at)
    WHERE status = 'pending';

COMMIT;
