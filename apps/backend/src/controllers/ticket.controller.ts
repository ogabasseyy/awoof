/**
 * Ticket HTTP controllers — requester + admin
 */

import type { Response } from 'express';
import { z } from 'zod';
import { UnauthorizedError } from '../common/errors/AppError.js';
import { success } from '../common/utils/response.js';
import type { AuthRequest } from '../middleware/auth.middleware.js';
import { TicketService, type RequesterRole } from '../services/support/ticket.service.js';

const createSchema = z.object({
    subject: z.string().min(3).max(255),
    message: z.string().min(5).max(10000),
    category: z
        .enum(['general', 'technical', 'billing', 'account', 'integration', 'product', 'order'])
        .default('general'),
});

const messageSchema = z.object({
    body: z.string().min(1).max(10000),
    isInternal: z.boolean().optional(),
});

const statusSchema = z.object({
    status: z.enum(['open', 'in-progress', 'resolved', 'closed']),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
});

function requireRequesterRole(role: string | undefined): RequesterRole {
    if (role === 'student' || role === 'vendor') return role;
    throw new UnauthorizedError('Only students and vendors can use this endpoint');
}

export class TicketController {
    public async create(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user) throw new UnauthorizedError('Not authenticated');
        const role = requireRequesterRole(req.user.role);
        const body = createSchema.parse(req.body);
        const ticket = await TicketService.createTicket({
            requesterUserId: req.user.userId,
            requesterRole: role,
            subject: body.subject,
            message: body.message,
            category: body.category,
        });
        success(res, { message: 'Ticket created', data: { ticket } }, 201);
    }

    public async listOwn(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user) throw new UnauthorizedError('Not authenticated');
        requireRequesterRole(req.user.role);
        const page = parseInt(String(req.query.page || '1'), 10);
        const limit = parseInt(String(req.query.limit || '20'), 10);
        const status = req.query.status ? String(req.query.status) : undefined;
        const result = await TicketService.listOwn({
            requesterUserId: req.user.userId,
            page,
            limit,
            ...(status ? { status } : {}),
        });
        success(res, { message: 'Tickets retrieved', data: result });
    }

    public async getOwn(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user) throw new UnauthorizedError('Not authenticated');
        const role = requireRequesterRole(req.user.role);
        const data = await TicketService.getTicket({
            ticketId: req.params.id as string,
            viewerUserId: req.user.userId,
            viewerRole: role,
        });
        success(res, { message: 'Ticket retrieved', data });
    }

    public async replyOwn(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user) throw new UnauthorizedError('Not authenticated');
        const role = requireRequesterRole(req.user.role);
        const body = messageSchema.parse(req.body);
        const message = await TicketService.addMessage({
            ticketId: req.params.id as string,
            authorUserId: req.user.userId,
            authorRole: role,
            body: body.body,
        });
        success(res, { message: 'Reply posted', data: { message } });
    }

    public async listAdmin(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user || req.user.role !== 'admin') {
            throw new UnauthorizedError('Admin only');
        }
        const result = await TicketService.listAll({
            page: parseInt(String(req.query.page || '1'), 10),
            limit: parseInt(String(req.query.limit || '20'), 10),
            ...(req.query.status ? { status: String(req.query.status) } : {}),
            ...(req.query.role ? { role: String(req.query.role) } : {}),
            ...(req.query.search ? { search: String(req.query.search) } : {}),
        });
        success(res, { message: 'Tickets retrieved', data: result });
    }

    public async getAdmin(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user || req.user.role !== 'admin') {
            throw new UnauthorizedError('Admin only');
        }
        const data = await TicketService.getTicket({
            ticketId: req.params.id as string,
            viewerUserId: req.user.userId,
            viewerRole: 'admin',
        });
        success(res, { message: 'Ticket retrieved', data });
    }

    public async replyAdmin(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user || req.user.role !== 'admin') {
            throw new UnauthorizedError('Admin only');
        }
        const body = messageSchema.parse(req.body);
        const message = await TicketService.addMessage({
            ticketId: req.params.id as string,
            authorUserId: req.user.userId,
            authorRole: 'admin',
            body: body.body,
            ...(body.isInternal !== undefined ? { isInternal: body.isInternal } : {}),
        });
        success(res, { message: 'Reply posted', data: { message } });
    }

    public async patchAdmin(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user || req.user.role !== 'admin') {
            throw new UnauthorizedError('Admin only');
        }
        const body = statusSchema.parse(req.body);
        const ticket = await TicketService.updateStatus({
            ticketId: req.params.id as string,
            status: body.status,
            ...(body.priority !== undefined ? { priority: body.priority } : {}),
        });
        success(res, { message: 'Ticket updated', data: { ticket } });
    }
}

export const ticketController = new TicketController();
