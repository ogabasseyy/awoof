-- Task review-loop: snapshot the catalog quote when a product-bound
-- merchant assertion is issued.
--
-- Additive only: two nullable price columns. Direct product assertions
-- (no claim session) previously sampled live catalog prices at exchange,
-- silently adopting edits the student never reviewed. Exchange now binds
-- the issuance quote; NULL marks generic assertions (no product) and
-- legacy rows, which keep the live-sampling path.
ALTER TABLE merchant_assertions
    ADD COLUMN IF NOT EXISTS list_price_snapshot NUMERIC(10, 2) CHECK (list_price_snapshot IS NULL OR list_price_snapshot >= 0),
    ADD COLUMN IF NOT EXISTS student_price_snapshot NUMERIC(10, 2) CHECK (student_price_snapshot IS NULL OR student_price_snapshot >= 0);
