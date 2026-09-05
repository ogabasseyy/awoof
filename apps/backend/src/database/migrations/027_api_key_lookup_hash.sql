ALTER TABLE api_keys
    ADD COLUMN IF NOT EXISTS lookup_hash VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_lookup_hash
    ON api_keys (lookup_hash)
    WHERE lookup_hash IS NOT NULL AND status = 'active';
