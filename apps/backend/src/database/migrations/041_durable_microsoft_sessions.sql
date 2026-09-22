-- Existing refresh credentials intentionally remain legacy (NULL) until the
-- account signs in again and receives a session-bound token pair.
ALTER TABLE users ADD COLUMN active_session_id UUID;
