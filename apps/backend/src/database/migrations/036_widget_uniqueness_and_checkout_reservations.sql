-- Do not silently choose which old merchant key remains authoritative.
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM widget_configs GROUP BY vendor_id HAVING count(*) > 1) THEN
        RAISE EXCEPTION 'Duplicate widget configurations require reconciliation before migration: SELECT vendor_id, count(*) FROM widget_configs GROUP BY vendor_id HAVING count(*) > 1';
    END IF;
END $$;
ALTER TABLE widget_configs ADD CONSTRAINT widget_configs_vendor_unique UNIQUE (vendor_id);

-- The former local expiry job did not close these provider authorizations.
UPDATE transactions SET status = 'pending', updated_at = CURRENT_TIMESTAMP
WHERE status = 'failed' AND payment_source = 'awoof'
  AND checkout_initialization_state = 'initialized' AND paystack_reference IS NOT NULL;
