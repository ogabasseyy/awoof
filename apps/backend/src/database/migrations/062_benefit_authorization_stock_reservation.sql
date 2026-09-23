-- Task review-loop: record whether a benefit authorization reserved
-- catalog stock when it was minted.
--
-- Additive only: new boolean defaults false, so rows minted before the
-- reservation fix keep the legacy report-time decrement path, while new
-- authorizations reserve one unit atomically at exchange and the report
-- path consumes the reservation instead of decrementing again. Expired
-- unused reservations are restored by the authorization cleanup.
ALTER TABLE merchant_benefit_authorizations
    ADD COLUMN IF NOT EXISTS stock_reserved boolean NOT NULL DEFAULT false;
