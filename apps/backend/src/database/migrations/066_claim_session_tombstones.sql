-- Task review-loop: retire spent claim sessions as tombstones instead of
-- deleting them.
--
-- Additive only: a nullable marker column, plus relaxing the nonce-digest
-- column so tombstones can scrub it. Deleting sessions dropped the
-- (vendor_id, checkout_id) uniqueness row (a reused checkout could start
-- a second single-use claim) and detached assertion references (exact
-- retries failed proof-shape validation before reaching their committed
-- receipts). Tombstones keep vendor, checkout, product, expiry, and
-- consumed state while scrubbing the nonce digest and origin.
ALTER TABLE merchant_claim_sessions
    ADD COLUMN IF NOT EXISTS tombstoned_at timestamptz NULL;
ALTER TABLE merchant_claim_sessions
    ALTER COLUMN browser_nonce_hash DROP NOT NULL;
