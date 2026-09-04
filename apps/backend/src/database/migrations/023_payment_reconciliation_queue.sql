-- Preserve successful charges that cannot be fulfilled for operator reconciliation.

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_status_check;
ALTER TABLE transactions
    ADD CONSTRAINT transactions_status_check
    CHECK (status IN ('pending', 'completed', 'failed', 'refunded', 'requires_refund'));

CREATE TABLE IF NOT EXISTS payment_reconciliation_queue (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    transaction_id UUID NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE RESTRICT,
    paystack_reference VARCHAR(255) NOT NULL,
    paid_amount DECIMAL(10, 2) NOT NULL CHECK (paid_amount >= 0),
    reason VARCHAR(50) NOT NULL CHECK (reason IN ('stock_unavailable', 'amount_mismatch')),
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

CREATE TABLE IF NOT EXISTS commerce_notification_outbox (
    transaction_id UUID PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'delivered', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error TEXT,
    processing_started_at TIMESTAMP WITH TIME ZONE,
    delivered_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE commerce_notification_outbox
    ADD COLUMN IF NOT EXISTS student_notified BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS savings_notified BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS student_emailed BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS vendor_notified BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS vendor_emailed BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_commerce_notification_outbox_pending
    ON commerce_notification_outbox (created_at)
    WHERE status IN ('pending', 'failed');
