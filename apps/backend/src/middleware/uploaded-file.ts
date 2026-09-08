import type { Request, Response } from 'express';
import path from 'node:path';
import { db } from '../config/database.js';
import { jwtService } from '../services/auth/jwt.service.js';

/** No catch-all static server: even legacy documents in vendors/ require auth. */
export async function uploadedFile(req: Request, res: Response): Promise<void> {
    const match = /^\/(vendors|private-vendors)\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?:\.[a-zA-Z0-9]+)?)$/.exec(req.path);
    if (!match || !['GET', 'HEAD'].includes(req.method)) { res.sendStatus(404); return; }
    const fileUrl = `/uploads${req.path}`;
    const documents = await db.query<{ user_id: string; deleted_at: Date | null }>(
        `SELECT user_id, deleted_at FROM vendors
         WHERE document_front_url = $1 OR document_back_url = $1`, [fileUrl],
    );
    if (documents.rows.length || match[1] === 'private-vendors') {
        res.set('Cache-Control', 'private, no-store');
        let userId: string;
        try {
            userId = jwtService.verifyAccessToken(req.headers.authorization?.replace(/^Bearer /, '') ?? '').userId;
        } catch { res.sendStatus(401); return; }
        const actor = await db.query<{ role: string }>(
            'SELECT role FROM users WHERE id = $1 AND deleted_at IS NULL', [userId],
        );
        const role = actor.rows[0]?.role;
        if (!documents.rows.some((owner) => owner.deleted_at === null
            && (role === 'admin' || (role === 'vendor' && owner.user_id === userId)))) {
            res.sendStatus(404); return;
        }
        res.set('Content-Disposition', 'attachment');
    } else {
        // Allow only published media references; orphaned/replaced identity files stay private.
        const publicMedia = await db.query(
            `SELECT 1 FROM vendors WHERE logo_url = $1 OR banner_url = $1
             UNION ALL SELECT 1 FROM products WHERE image_url = $1 LIMIT 1`, [fileUrl],
        );
        if (!publicMedia.rows.length) { res.sendStatus(404); return; }
    }
    res.sendFile(path.resolve('uploads', match[1]!, match[2]!));
}
