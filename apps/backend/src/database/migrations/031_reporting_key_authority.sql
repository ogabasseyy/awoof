-- Preserve the latest active key while repairing historical concurrent rotations.
WITH ranked AS (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY vendor_id ORDER BY created_at DESC, id DESC) AS position
    FROM api_keys WHERE status = 'active' AND vendor_id IS NOT NULL
)
UPDATE api_keys SET status = 'revoked', updated_at = CURRENT_TIMESTAMP
WHERE id IN (SELECT id FROM ranked WHERE position > 1);

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_one_active_vendor
    ON api_keys(vendor_id) WHERE status = 'active';

ALTER TABLE api_keys
    ADD COLUMN IF NOT EXISTS window_started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN IF NOT EXISTS window_count INTEGER NOT NULL DEFAULT 0 CHECK (window_count >= 0);
