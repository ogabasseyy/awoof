-- Never infer historical credits from list_price_snapshot: migration 024
-- backfilled it from a mutable product price. NULL means reconciliation required.
ALTER TABLE transactions ADD COLUMN recorded_savings_delta NUMERIC(10, 2);
COMMENT ON COLUMN transactions.recorded_savings_delta IS
    'Exact savings credit posted for this transaction, or NULL when unknown. Never backfill from product prices.';
