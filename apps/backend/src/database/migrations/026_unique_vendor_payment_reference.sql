-- Prevent concurrent vendor transaction reports from inserting the same payment twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_vendor_payment_reference_unique
    ON transactions (vendor_id, vendor_payment_reference)
    WHERE vendor_payment_reference IS NOT NULL;
