-- Task review-round-4: quote the catalog prices when a merchant claim
-- session starts, so the later benefit authorization binds what the
-- student reviewed instead of resampling a possibly edited catalog.
--
-- Additive only. Legacy rows predate the quote and stay NULL; the
-- exchange falls back to a live sample for those (they expire within
-- minutes of deployment), while every new session carries its quote.
ALTER TABLE merchant_claim_sessions
    ADD COLUMN IF NOT EXISTS list_price_snapshot NUMERIC(10, 2),
    ADD COLUMN IF NOT EXISTS student_price_snapshot NUMERIC(10, 2);
