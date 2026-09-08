-- Fail atomically on conflicting historical records; never discard financial history.
ALTER TABLE transactions ADD CONSTRAINT transactions_one_paystack_reference CHECK (
    payment_source IS DISTINCT FROM 'vendor_paystack' OR
    (vendor_payment_reference IS NOT NULL AND length(trim(vendor_payment_reference)) > 0
     AND (paystack_reference IS NULL OR paystack_reference = vendor_payment_reference))
);
CREATE UNIQUE INDEX transactions_global_paystack_reference ON transactions
    ((COALESCE(paystack_reference, CASE WHEN payment_source = 'vendor_paystack' THEN vendor_payment_reference END)))
    WHERE paystack_reference IS NOT NULL OR payment_source = 'vendor_paystack';

ALTER TABLE transactions ADD COLUMN checkout_initialization_state text
    CHECK (checkout_initialization_state IN ('initializing', 'initialized', 'unknown'));
ALTER TABLE transactions ADD COLUMN checkout_authorization_url text;
-- Old pending requests may already exist at the provider. Reconcile before retrying.
UPDATE transactions SET checkout_initialization_state = 'unknown'
    WHERE payment_source = 'awoof' AND paystack_reference IS NOT NULL AND status = 'pending';
