-- Task review-loop: bind each merchant claim session to its initiating
-- origin.
--
-- Additive only. New sessions always carry the merchant-declared origin
-- (validated against the vendor's active allowlist at creation); legacy
-- rows predate the binding and stay NULL, which the read path treats as
-- expired (fail closed) instead of guessing the alphabetically first
-- configured origin.
ALTER TABLE merchant_claim_sessions
    ADD COLUMN IF NOT EXISTS origin text;
