/**
 * Unified ticket service — create/list/reply/status for students, vendors, admins.
 */

import { db } from '../../config/database.js';
import {
    BadRequestError,
    ForbiddenError,
    NotFoundError,
} from '../../common/errors/AppError.js';
import { NotificationService } from '../notification/notification.service.js';
import {
    sendSupportTicketCreatedEmail,
    sendSupportTicketReplyEmail,
    sendSupportTicketStatusEmail,
} from '../email/email.service.js';
import { appLogger } from '../../common/logger.js';

export type TicketStatus = 'open' | 'in-progress' | 'resolved' | 'closed';
export type RequesterRole = 'student' | 'vendor';
export type AuthorRole = 'student' | 'vendor' | 'admin';

const CATEGORIES = [
    'general',
    'technical',
    'billing',
    'account',
    'integration',
    'product',
    'order',
] as const;

function mapTicket(row: Record<string, unknown>) {
    return {
        id: row.id,
        requesterUserId: row.requester_user_id,
        requesterRole: row.requester_role,
        requesterEmail: row.requester_email ?? null,
        requesterName: row.requester_name ?? null,
        subject: row.subject,
        category: row.category,
        status: row.status,
        priority: row.priority,
        resolvedAt: row.resolved_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        messageCount: row.message_count != null ? parseInt(String(row.message_count), 10) : undefined,
    };
}

function mapMessage(row: Record<string, unknown>) {
    return {
        id: row.id,
        ticketId: row.ticket_id,
        authorUserId: row.author_user_id,
        authorRole: row.author_role,
        authorEmail: row.author_email ?? null,
        body: row.body,
        isInternal: row.is_internal === true,
        createdAt: row.created_at,
    };
}

async function getAdminUserIds(): Promise<string[]> {
    const result = await db.query(
        `SELECT id FROM users WHERE role = 'admin' AND deleted_at IS NULL`
    );
    return result.rows.map((r) => r.id as string);
}

async function getUserEmail(userId: string): Promise<string | null> {
    const result = await db.query(
        `SELECT email FROM users WHERE id = $1 AND deleted_at IS NULL`,
        [userId]
    );
    return result.rows[0]?.email ?? null;
}

export class TicketService {
    static async createTicket(params: {
        requesterUserId: string;
        requesterRole: RequesterRole;
        subject: string;
        message: string;
        category: string;
    }) {
        const category = CATEGORIES.includes(params.category as (typeof CATEGORIES)[number])
            ? params.category
            : 'general';

        const insert = await db.query(
            `INSERT INTO tickets (requester_user_id, requester_role, subject, category, status, priority)
             VALUES ($1, $2, $3, $4, 'open', 'normal')
             RETURNING *`,
            [params.requesterUserId, params.requesterRole, params.subject, category]
        );
        const ticket = insert.rows[0];

        await db.query(
            `INSERT INTO ticket_messages (ticket_id, author_user_id, author_role, body, is_internal)
             VALUES ($1, $2, $3, $4, false)`,
            [ticket.id, params.requesterUserId, params.requesterRole, params.message]
        );

        // Notify admins (in-app + email ops)
        try {
            const adminIds = await getAdminUserIds();
            await NotificationService.notifyMany(adminIds, {
                title: 'New support ticket',
                message: `${params.requesterRole}: ${params.subject}`,
                type: 'info',
                kind: 'support_ticket_created',
                metadata: { ticketId: ticket.id },
            });
            const opsEmail = process.env.SUPPORT_EMAIL;
            if (opsEmail) {
                await sendSupportTicketCreatedEmail(
                    opsEmail,
                    params.subject,
                    params.requesterRole,
                    ticket.id
                );
            }
        } catch (error) {
            appLogger.error('Ticket create notification/email failed', error);
        }

        return mapTicket(ticket);
    }

    static async listOwn(params: {
        requesterUserId: string;
        page?: number;
        limit?: number;
        status?: string;
    }) {
        const page = params.page ?? 1;
        const limit = params.limit ?? 20;
        const offset = (page - 1) * limit;
        const values: (string | number)[] = [params.requesterUserId];
        let where = 'WHERE t.requester_user_id = $1';
        if (params.status) {
            values.push(params.status);
            where += ` AND t.status = $${values.length}`;
        }

        const result = await db.query(
            `SELECT t.*,
                    (SELECT COUNT(*)::int FROM ticket_messages m WHERE m.ticket_id = t.id AND m.is_internal = false) AS message_count
             FROM tickets t
             ${where}
             ORDER BY t.updated_at DESC
             LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
            [...values, limit, offset]
        );

        const countResult = await db.query(
            `SELECT COUNT(*)::int AS total FROM tickets t ${where}`,
            values
        );

        return {
            tickets: result.rows.map(mapTicket),
            pagination: {
                page,
                limit,
                total: countResult.rows[0].total,
                totalPages: Math.ceil(countResult.rows[0].total / limit) || 1,
            },
        };
    }

    static async listAll(params: {
        page?: number;
        limit?: number;
        status?: string;
        role?: string;
        search?: string;
    }) {
        const page = params.page ?? 1;
        const limit = params.limit ?? 20;
        const offset = (page - 1) * limit;
        const values: (string | number)[] = [];
        const clauses: string[] = [];

        if (params.status) {
            values.push(params.status);
            clauses.push(`t.status = $${values.length}`);
        }
        if (params.role === 'student' || params.role === 'vendor') {
            values.push(params.role);
            clauses.push(`t.requester_role = $${values.length}`);
        }
        if (params.search?.trim()) {
            values.push(`%${params.search.trim()}%`);
            clauses.push(
                `(t.subject ILIKE $${values.length} OR u.email ILIKE $${values.length} OR COALESCE(s.name, v.company_name, v.name, '') ILIKE $${values.length})`
            );
        }

        const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

        const result = await db.query(
            `SELECT t.*,
                    u.email AS requester_email,
                    COALESCE(s.name, v.company_name, v.name) AS requester_name,
                    (SELECT COUNT(*)::int FROM ticket_messages m WHERE m.ticket_id = t.id) AS message_count
             FROM tickets t
             JOIN users u ON u.id = t.requester_user_id
             LEFT JOIN students s ON s.user_id = t.requester_user_id AND t.requester_role = 'student'
             LEFT JOIN vendors v ON v.user_id = t.requester_user_id AND t.requester_role = 'vendor'
             ${where}
             ORDER BY
               CASE t.status WHEN 'open' THEN 0 WHEN 'in-progress' THEN 1 ELSE 2 END,
               t.updated_at DESC
             LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
            [...values, limit, offset]
        );

        const countResult = await db.query(
            `SELECT COUNT(*)::int AS total
             FROM tickets t
             JOIN users u ON u.id = t.requester_user_id
             LEFT JOIN students s ON s.user_id = t.requester_user_id AND t.requester_role = 'student'
             LEFT JOIN vendors v ON v.user_id = t.requester_user_id AND t.requester_role = 'vendor'
             ${where}`,
            values
        );

        return {
            tickets: result.rows.map(mapTicket),
            pagination: {
                page,
                limit,
                total: countResult.rows[0].total,
                totalPages: Math.ceil(countResult.rows[0].total / limit) || 1,
            },
        };
    }

    static async getTicket(params: {
        ticketId: string;
        viewerUserId: string;
        viewerRole: AuthorRole;
    }) {
        const ticketResult = await db.query(
            `SELECT t.*,
                    u.email AS requester_email,
                    COALESCE(s.name, v.company_name, v.name) AS requester_name
             FROM tickets t
             JOIN users u ON u.id = t.requester_user_id
             LEFT JOIN students s ON s.user_id = t.requester_user_id AND t.requester_role = 'student'
             LEFT JOIN vendors v ON v.user_id = t.requester_user_id AND t.requester_role = 'vendor'
             WHERE t.id = $1`,
            [params.ticketId]
        );

        if (ticketResult.rows.length === 0) {
            throw new NotFoundError('Ticket not found');
        }

        const ticket = ticketResult.rows[0];
        if (
            params.viewerRole !== 'admin' &&
            ticket.requester_user_id !== params.viewerUserId
        ) {
            throw new ForbiddenError('You cannot view this ticket');
        }

        const includeInternal = params.viewerRole === 'admin';
        const messagesResult = await db.query(
            `SELECT m.*, u.email AS author_email
             FROM ticket_messages m
             LEFT JOIN users u ON u.id = m.author_user_id
             WHERE m.ticket_id = $1
               ${includeInternal ? '' : 'AND m.is_internal = false'}
             ORDER BY m.created_at ASC`,
            [params.ticketId]
        );

        return {
            ticket: mapTicket(ticket),
            messages: messagesResult.rows.map(mapMessage),
        };
    }

    static async addMessage(params: {
        ticketId: string;
        authorUserId: string;
        authorRole: AuthorRole;
        body: string;
        isInternal?: boolean;
    }) {
        const ticketResult = await db.query(`SELECT * FROM tickets WHERE id = $1`, [
            params.ticketId,
        ]);
        if (ticketResult.rows.length === 0) {
            throw new NotFoundError('Ticket not found');
        }
        const ticket = ticketResult.rows[0];

        if (params.authorRole !== 'admin') {
            if (ticket.requester_user_id !== params.authorUserId) {
                throw new ForbiddenError('You cannot reply to this ticket');
            }
            if (ticket.status === 'closed') {
                throw new BadRequestError('This ticket is closed');
            }
            if (params.isInternal) {
                throw new ForbiddenError('Only admins can post internal notes');
            }
        }

        const isInternal = params.authorRole === 'admin' && params.isInternal === true;

        const msg = await db.query(
            `INSERT INTO ticket_messages (ticket_id, author_user_id, author_role, body, is_internal)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [params.ticketId, params.authorUserId, params.authorRole, params.body, isInternal]
        );

        await db.query(
            `UPDATE tickets SET updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [params.ticketId]
        );

        // Reopen if admin replies to resolved
        if (
            params.authorRole === 'admin' &&
            !isInternal &&
            (ticket.status === 'resolved' || ticket.status === 'closed')
        ) {
            await db.query(
                `UPDATE tickets SET status = 'in-progress', resolved_at = NULL, updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1`,
                [params.ticketId]
            );
        } else if (
            params.authorRole === 'admin' &&
            !isInternal &&
            ticket.status === 'open'
        ) {
            await db.query(
                `UPDATE tickets SET status = 'in-progress', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
                [params.ticketId]
            );
        }

        if (!isInternal) {
            try {
                if (params.authorRole === 'admin') {
                    await NotificationService.notifyUser(ticket.requester_user_id, {
                        title: 'Support reply',
                        message: `New reply on: ${ticket.subject}`,
                        type: 'info',
                        kind: 'support_reply',
                        metadata: { ticketId: ticket.id },
                    });
                    const email = await getUserEmail(ticket.requester_user_id);
                    if (email) {
                        await sendSupportTicketReplyEmail(
                            email,
                            ticket.subject,
                            params.body,
                            ticket.id,
                            ticket.requester_role
                        );
                    }
                } else {
                    const adminIds = await getAdminUserIds();
                    await NotificationService.notifyMany(adminIds, {
                        title: 'Ticket reply',
                        message: `${ticket.requester_role} replied: ${ticket.subject}`,
                        type: 'info',
                        kind: 'support_reply',
                        metadata: { ticketId: ticket.id },
                    });
                    const opsEmail = process.env.SUPPORT_EMAIL;
                    if (opsEmail) {
                        await sendSupportTicketReplyEmail(
                            opsEmail,
                            ticket.subject,
                            params.body,
                            ticket.id,
                            'admin'
                        );
                    }
                }
            } catch (error) {
                appLogger.error('Ticket reply notification/email failed', error);
            }
        }

        return mapMessage(msg.rows[0]);
    }

    static async updateStatus(params: {
        ticketId: string;
        status: TicketStatus;
        priority?: string;
    }) {
        const ticketResult = await db.query(`SELECT * FROM tickets WHERE id = $1`, [
            params.ticketId,
        ]);
        if (ticketResult.rows.length === 0) {
            throw new NotFoundError('Ticket not found');
        }
        const ticket = ticketResult.rows[0];

        const resolvedAt =
            params.status === 'resolved' || params.status === 'closed'
                ? new Date().toISOString()
                : null;

        const updated = await db.query(
            `UPDATE tickets
             SET status = $1,
                 priority = COALESCE($2, priority),
                 resolved_at = $3,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $4
             RETURNING *`,
            [params.status, params.priority ?? null, resolvedAt, params.ticketId]
        );

        try {
            await NotificationService.notifyUser(ticket.requester_user_id, {
                title: 'Ticket status updated',
                message: `"${ticket.subject}" is now ${params.status}`,
                type: 'info',
                kind: 'support_status',
                metadata: { ticketId: ticket.id, status: params.status },
            });
            const email = await getUserEmail(ticket.requester_user_id);
            if (email) {
                await sendSupportTicketStatusEmail(
                    email,
                    ticket.subject,
                    params.status,
                    ticket.id,
                    ticket.requester_role
                );
            }
        } catch (error) {
            appLogger.error('Ticket status notification/email failed', error);
        }

        return mapTicket(updated.rows[0]);
    }
}
