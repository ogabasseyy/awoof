-- Validate the merchant Paystack constraints added NOT VALID in 085.
-- VALIDATE CONSTRAINT takes only SHARE UPDATE EXCLUSIVE and runs in its own
-- migration because the runner wraps each file in a single transaction.
ALTER TABLE transactions VALIDATE CONSTRAINT transactions_payment_source_check;
ALTER TABLE transactions VALIDATE CONSTRAINT transactions_merchant_paystack_reference;
