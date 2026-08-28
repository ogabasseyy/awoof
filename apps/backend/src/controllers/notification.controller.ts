/**
 * Shared notification controller (all authenticated roles)
 */

import type { Response } from 'express';
import { z } from 'zod';
import { db } from '../config/database.js';
import { UnauthorizedError, NotFoundError } from '../common/errors/AppError.js';
import { success } from '../common/utils/response.js';
import type { AuthRequest } from '../middleware/auth.middleware.js';

export class NotificationController {
    public async list(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user) throw new UnauthorizedError('Not authenticated');
        const page = parseInt(String(req.query.page || '1'), 10);
        const limit = parseInt(String(req.query.limit || '20'), 10);
        const offset = (page - 1) * limit;
        const unreadOnly = String(req.query.unreadOnly || '') === 'true';

        const values: (string | number)[] = [req.user.userId];
        let where = 'WHERE user_id = $1';
        if (unreadOnly) where += ' AND read = false';

        const result = await db.query(
            `SELECT id, title, message, type, kind, read, metadata, created_at, read_at
             FROM notifications ${where}
             ORDER BY created_at DESC
             LIMIT $2 OFFSET $3`,
            [...values, limit, offset]
        );

        const countResult = await db.query(
            `SELECT COUNT(*)::int AS total FROM notifications ${where}`,
            values
        );
        const unreadResult = await db.query(
            `SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND read = false`,
            [req.user.userId]
        );

        success(res, {
            message: 'Notifications retrieved',
            data: {
                notifications: result.rows.map((n) => ({
                    id: n.id,
                    title: n.title,
                    message: n.message,
                    type: n.type,
                    kind: n.kind,
                    read: n.read,
                    metadata: n.metadata,
                    createdAt: n.created_at,
                    readAt: n.read_at,
                })),
                unreadCount: unreadResult.rows[0].count,
                pagination: {
                    page,
                    limit,
                    total: countResult.rows[0].total,
                    totalPages: Math.ceil(countResult.rows[0].total / limit) || 1,
                },
            },
        });
    }

    public async unreadCount(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user) throw new UnauthorizedError('Not authenticated');
        const result = await db.query(
            `SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND read = false`,
            [req.user.userId]
        );
        success(res, {
            message: 'Unread count',
            data: { unreadCount: result.rows[0].count },
        });
    }

    public async markRead(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user) throw new UnauthorizedError('Not authenticated');
        const schema = z.object({
            notificationIds: z.array(z.string().uuid()).optional(),
            markAll: z.boolean().optional(),
        });
        const body = schema.parse(req.body);

        if (body.markAll) {
            await db.query(
                `UPDATE notifications SET read = true, read_at = CURRENT_TIMESTAMP
                 WHERE user_id = $1 AND read = false`,
                [req.user.userId]
            );
        } else if (body.notificationIds?.length) {
            await db.query(
                `UPDATE notifications SET read = true, read_at = CURRENT_TIMESTAMP
                 WHERE user_id = $1 AND id = ANY($2::uuid[])`,
                [req.user.userId, body.notificationIds]
            );
        }

        success(res, { message: 'Notifications marked read', data: {} });
    }

    public async markOneRead(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user) throw new UnauthorizedError('Not authenticated');
        const result = await db.query(
            `UPDATE notifications SET read = true, read_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND user_id = $2
             RETURNING id`,
            [req.params.id, req.user.userId]
        );
        if (result.rows.length === 0) throw new NotFoundError('Notification not found');
        success(res, { message: 'Notification marked read', data: {} });
    }

    public async remove(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user) throw new UnauthorizedError('Not authenticated');
        const result = await db.query(
            `DELETE FROM notifications WHERE id = $1 AND user_id = $2 RETURNING id`,
            [req.params.id, req.user.userId]
        );
        if (result.rows.length === 0) throw new NotFoundError('Notification not found');
        success(res, { message: 'Notification deleted', data: {} });
    }
}

export const notificationController = new NotificationController();
