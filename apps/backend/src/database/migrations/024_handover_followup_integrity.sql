ALTER TABLE commerce_notification_outbox
    ADD COLUMN IF NOT EXISTS student_notified BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS savings_notified BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS student_emailed BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS vendor_notified BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS vendor_emailed BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS list_price_snapshot DECIMAL(10, 2);
UPDATE transactions t SET list_price_snapshot = p.price
FROM products p WHERE t.product_id = p.id AND t.list_price_snapshot IS NULL;

CREATE TABLE IF NOT EXISTS payout_change_requests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
    bank_name VARCHAR(255) NOT NULL,
    bank_code VARCHAR(50) NOT NULL,
    account_number VARCHAR(50) NOT NULL,
    account_name VARCHAR(255) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'failed')),
    error TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payout_change_requests_one_pending
    ON payout_change_requests(vendor_id) WHERE status = 'pending';
