import assert from 'node:assert/strict';
import { it } from 'node:test';
import { db } from '../../config/database.js';
import { TicketService } from './ticket.service.js';

for (const role of ['student', 'vendor', 'admin'] as const) {
    it(`limits staff email attribution to admin ticket viewers (${role})`, async (t) => {
        t.mock.method(db, 'query', async (sql: string) => ({
            rows: sql.includes('FROM tickets t')
                ? [{ id: 'ticket', requester_user_id: 'owner' }]
                : [{ id: 'reply', author_role: 'admin', author_email: 'staff-login@example.test', body: 'Public support reply', is_internal: false }],
        }));
        const result = await TicketService.getTicket({ ticketId: 'ticket', viewerUserId: 'owner', viewerRole: role });
        assert.equal(result.messages[0].body, 'Public support reply');
        assert.equal(result.messages[0].authorRole, 'admin');
        assert.equal(result.messages[0].authorEmail, role === 'admin' ? 'staff-login@example.test' : null);
        if (role !== 'admin') assert.ok(!JSON.stringify(result).includes('staff-login@example.test'));
    });
}
