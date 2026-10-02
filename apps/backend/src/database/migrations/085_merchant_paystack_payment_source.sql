-- Merchant-account references are vendor scoped. Existing Awoof Paystack
-- global uniqueness and legacy reference constraints remain unchanged.
-- Added NOT VALID: the runner wraps each file in one transaction, so the
-- lower-lock VALIDATE CONSTRAINT steps live in the follow-up migration 086.
ALTER TABLE transactions DROP CONSTRAINT transactions_payment_source_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_payment_source_check
    CHECK (payment_source IN ('awoof', 'vendor_paystack', 'vendor_other', 'vendor_merchant_paystack')) NOT VALID;
ALTER TABLE transactions ADD CONSTRAINT transactions_merchant_paystack_reference CHECK (
    payment_source IS DISTINCT FROM 'vendor_merchant_paystack' OR
    (vendor_payment_reference IS NOT NULL AND length(trim(vendor_payment_reference)) > 0
     AND paystack_reference IS NULL)
) NOT VALID;
