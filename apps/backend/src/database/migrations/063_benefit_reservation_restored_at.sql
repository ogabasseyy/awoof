-- Task review-loop: record when an expired benefit reservation released
-- its catalog unit back to stock.
--
-- Additive only: nullable timestamp, unset for every existing row. Stock
-- is restored when the short-lived authorization expires, independently
-- of the seven-day row-retention cleanup; the flag keeps both paths
-- idempotent so a unit is never restored twice.
ALTER TABLE merchant_benefit_authorizations
    ADD COLUMN IF NOT EXISTS stock_restored_at timestamptz NULL;
