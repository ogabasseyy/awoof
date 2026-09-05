ALTER TABLE users
    ADD COLUMN IF NOT EXISTS refresh_token_hash VARCHAR(64),
    ADD COLUMN IF NOT EXISTS refresh_token_expires_at TIMESTAMPTZ;
