-- Migration: Add deal_type to products and platform_settings for admin
-- deal_type: 'product' = regular product (payment: Awoof or vendor website per vendor setting)
--            'voucher' = voucher/coupon (payment always on vendor website via widget)

ALTER TABLE products
ADD COLUMN IF NOT EXISTS deal_type VARCHAR(20) DEFAULT 'product'
    CHECK (deal_type IN ('product', 'voucher'));

CREATE INDEX IF NOT EXISTS idx_products_deal_type ON products(deal_type) WHERE deleted_at IS NULL;

-- Platform settings (e.g. Awoof commission % of discounted total when payment is processed by Awoof)
CREATE TABLE IF NOT EXISTS platform_settings (
    key VARCHAR(100) PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO platform_settings (key, value) VALUES ('platform_fee_percent', '10')
ON CONFLICT (key) DO NOTHING;
