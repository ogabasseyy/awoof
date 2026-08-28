-- Unified tickets + user-scoped notifications
-- Migrates legacy support_tickets / vendor_support_tickets into tickets + ticket_messages

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 1) Rename legacy student support tables (name collision avoidance)
ALTER TABLE IF EXISTS support_ticket_responses RENAME TO support_ticket_responses_legacy;
ALTER TABLE IF EXISTS support_tickets RENAME TO support_tickets_legacy;

DROP TRIGGER IF EXISTS update_support_tickets_updated_at ON support_tickets_legacy;
DROP TRIGGER IF EXISTS update_support_tickets_legacy_updated_at ON support_tickets_legacy;
CREATE TRIGGER update_support_tickets_legacy_updated_at
    BEFORE UPDATE ON support_tickets_legacy
    FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();

-- 2) New unified tables
CREATE TABLE IF NOT EXISTS tickets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    requester_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    requester_role VARCHAR(20) NOT NULL CHECK (requester_role IN ('student', 'vendor')),
    subject VARCHAR(255) NOT NULL,
    category VARCHAR(50) NOT NULL DEFAULT 'general'
        CHECK (category IN ('general', 'technical', 'billing', 'account', 'integration', 'product', 'order')),
    status VARCHAR(20) NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'in-progress', 'resolved', 'closed')),
    priority VARCHAR(20) DEFAULT 'normal'
        CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    resolved_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tickets_requester ON tickets(requester_user_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_created_at ON tickets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_status_created ON tickets(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_role ON tickets(requester_role);

DROP TRIGGER IF EXISTS update_tickets_updated_at ON tickets;
CREATE TRIGGER update_tickets_updated_at
    BEFORE UPDATE ON tickets
    FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();

CREATE TABLE IF NOT EXISTS ticket_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    author_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    author_role VARCHAR(20) NOT NULL CHECK (author_role IN ('student', 'vendor', 'admin')),
    body TEXT NOT NULL,
    is_internal BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket ON ticket_messages(ticket_id);
CREATE INDEX IF NOT EXISTS idx_ticket_messages_created ON ticket_messages(created_at DESC);

-- 3) Migrate student tickets
INSERT INTO tickets (
    id, requester_user_id, requester_role, subject, category, status, priority, resolved_at, created_at, updated_at
)
SELECT
    t.id,
    s.user_id,
    'student',
    t.subject,
    CASE
        WHEN t.category IN ('general', 'technical', 'billing', 'account', 'integration', 'product', 'order')
            THEN t.category
        ELSE 'general'
    END,
    t.status,
    COALESCE(t.priority, 'normal'),
    t.resolved_at,
    t.created_at,
    t.updated_at
FROM support_tickets_legacy t
JOIN students s ON s.id = t.student_id
ON CONFLICT (id) DO NOTHING;

INSERT INTO ticket_messages (ticket_id, author_user_id, author_role, body, is_internal, created_at)
SELECT
    t.id,
    s.user_id,
    'student',
    t.message,
    false,
    t.created_at
FROM support_tickets_legacy t
JOIN students s ON s.id = t.student_id
WHERE NOT EXISTS (
    SELECT 1 FROM ticket_messages m WHERE m.ticket_id = t.id AND m.body = t.message AND m.created_at = t.created_at
);

INSERT INTO ticket_messages (id, ticket_id, author_user_id, author_role, body, is_internal, created_at)
SELECT
    r.id,
    r.ticket_id,
    r.user_id,
    CASE WHEN r.user_role = 'admin' THEN 'admin' ELSE 'student' END,
    r.message,
    COALESCE(r.is_internal, false),
    r.created_at
FROM support_ticket_responses_legacy r
WHERE EXISTS (SELECT 1 FROM tickets tk WHERE tk.id = r.ticket_id)
ON CONFLICT (id) DO NOTHING;

-- 4) Migrate vendor tickets (new UUIDs for tickets that might collide — vendor ids are separate UUID space, keep ids)
INSERT INTO tickets (
    id, requester_user_id, requester_role, subject, category, status, priority, resolved_at, created_at, updated_at
)
SELECT
    t.id,
    v.user_id,
    'vendor',
    t.subject,
    CASE
        WHEN t.category IN ('general', 'technical', 'billing', 'account', 'integration', 'product', 'order')
            THEN t.category
        ELSE 'general'
    END,
    t.status,
    COALESCE(t.priority, 'normal'),
    t.resolved_at,
    t.created_at,
    t.updated_at
FROM vendor_support_tickets t
JOIN vendors v ON v.id = t.vendor_id
ON CONFLICT (id) DO NOTHING;

INSERT INTO ticket_messages (ticket_id, author_user_id, author_role, body, is_internal, created_at)
SELECT
    t.id,
    v.user_id,
    'vendor',
    t.message,
    false,
    t.created_at
FROM vendor_support_tickets t
JOIN vendors v ON v.id = t.vendor_id
WHERE NOT EXISTS (
    SELECT 1 FROM ticket_messages m WHERE m.ticket_id = t.id AND m.body = t.message AND m.created_at = t.created_at
);

INSERT INTO ticket_messages (id, ticket_id, author_user_id, author_role, body, is_internal, created_at)
SELECT
    r.id,
    r.ticket_id,
    r.user_id,
    CASE WHEN r.user_role = 'admin' THEN 'admin' ELSE 'vendor' END,
    r.message,
    COALESCE(r.is_internal, false),
    r.created_at
FROM vendor_support_ticket_responses r
WHERE EXISTS (SELECT 1 FROM tickets tk WHERE tk.id = r.ticket_id)
ON CONFLICT (id) DO NOTHING;

-- 5) Notifications → user_id
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS kind VARCHAR(50);

UPDATE notifications n
SET user_id = s.user_id
FROM students s
WHERE n.student_id = s.id AND n.user_id IS NULL;

DELETE FROM notifications WHERE user_id IS NULL;

ALTER TABLE notifications ALTER COLUMN user_id SET NOT NULL;

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_student_id_fkey;
DROP INDEX IF EXISTS idx_notifications_student_id;
DROP INDEX IF EXISTS idx_notifications_read;
ALTER TABLE notifications DROP COLUMN IF EXISTS student_id;

CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, read) WHERE read = false;
CREATE INDEX IF NOT EXISTS idx_notifications_kind ON notifications(kind) WHERE kind IS NOT NULL;

-- 6) Drop legacy support tables
DROP TABLE IF EXISTS support_ticket_responses_legacy CASCADE;
DROP TABLE IF EXISTS support_tickets_legacy CASCADE;
DROP TABLE IF EXISTS vendor_support_ticket_responses CASCADE;
DROP TABLE IF EXISTS vendor_support_tickets CASCADE;
