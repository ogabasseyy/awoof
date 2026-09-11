-- Migration: Add verification tokens table and update transactions table
-- Date: 2025-01-XX
-- Description: Adds verification token system for widget integration and updates transactions table


-- Create verification_tokens table for widget verification
CREATE TABLE IF NOT EXISTS verification_tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
    token VARCHAR(500) NOT NULL UNIQUE,
    product_id UUID REFERENCES products(id),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    used_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_verification_tokens_token ON verification_tokens(token);
CREATE INDEX idx_verification_tokens_student_vendor ON verification_tokens(student_id, vendor_id);
CREATE INDEX idx_verification_tokens_expires_at ON verification_tokens(expires_at);
CREATE INDEX idx_verification_tokens_used_at ON verification_tokens(used_at) WHERE used_at IS NULL;

-- Add new columns to transactions table for vendor website payments
ALTER TABLE transactions 
    ADD COLUMN IF NOT EXISTS verification_token VARCHAR(500),
    ADD COLUMN IF NOT EXISTS payment_source VARCHAR(50) DEFAULT 'awoof' CHECK (payment_source IN ('awoof', 'vendor_paystack', 'vendor_other')),
    ADD COLUMN IF NOT EXISTS vendor_payment_reference VARCHAR(255),
    ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP WITH TIME ZONE;

-- Create indexes for new transaction columns
CREATE INDEX IF NOT EXISTS idx_transactions_verification_token ON transactions(verification_token) WHERE verification_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_payment_source ON transactions(payment_source);
CREATE INDEX IF NOT EXISTS idx_transactions_vendor_payment_reference ON transactions(vendor_payment_reference) WHERE vendor_payment_reference IS NOT NULL;

-- Add foreign key constraint for verification_token in transactions
-- Note: This references verification_tokens.token, but we'll handle validation in application code
-- since we can't create a foreign key on a non-primary key column directly

