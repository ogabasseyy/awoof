-- Durable delivery claims, separate from the user-clearable notification inbox.
CREATE TABLE IF NOT EXISTS savings_milestones (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    milestone INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, milestone)
);

-- Honor milestones that were announced before deduplication was introduced.
INSERT INTO savings_milestones (user_id, milestone)
SELECT DISTINCT user_id, (metadata->>'milestone')::integer
FROM notifications
WHERE kind = 'savings'
  AND metadata->>'milestone' IN ('1000', '5000', '10000', '25000', '50000', '100000')
ON CONFLICT (user_id, milestone) DO NOTHING;
