-- Forward repair for installations that already recorded migration 022.
ALTER TABLE notifications ALTER COLUMN student_id DROP NOT NULL;

DO $$
DECLARE source_table TEXT;
BEGIN
    FOREACH source_table IN ARRAY ARRAY['support_tickets_legacy', 'vendor_support_tickets'] LOOP
        IF to_regclass(source_table) IS NOT NULL THEN
            EXECUTE format($query$
                INSERT INTO ticket_messages (ticket_id, author_user_id, author_role, body, is_internal, created_at)
                SELECT t.id, NULL, 'admin', t.admin_notes, true, COALESCE(t.updated_at, t.created_at)
                FROM %I t
                WHERE NULLIF(BTRIM(t.admin_notes), '') IS NOT NULL
                  AND EXISTS (SELECT 1 FROM tickets tk WHERE tk.id = t.id)
                  AND NOT EXISTS (SELECT 1 FROM ticket_messages m WHERE m.ticket_id = t.id
                      AND m.author_role = 'admin' AND m.is_internal AND m.body = t.admin_notes)
            $query$, source_table);
        END IF;
    END LOOP;
END $$;
