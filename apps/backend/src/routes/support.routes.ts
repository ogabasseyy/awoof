/**
 * Support + notification routes (shared)
 */

import { Router } from 'express';
import { asyncHandler } from '../common/middleware/errorHandler.js';
import { authenticate, requireRole } from '../middleware/auth.middleware.js';
import { ticketController } from '../controllers/ticket.controller.js';
import { notificationController } from '../controllers/notification.controller.js';

const router = Router();

router.use(authenticate);

// Notifications (all roles)
router.get(
    '/notifications',
    asyncHandler(notificationController.list.bind(notificationController))
);
router.get(
    '/notifications/unread-count',
    asyncHandler(notificationController.unreadCount.bind(notificationController))
);
router.put(
    '/notifications/read',
    asyncHandler(notificationController.markRead.bind(notificationController))
);
router.put(
    '/notifications/:id/read',
    asyncHandler(notificationController.markOneRead.bind(notificationController))
);
router.delete(
    '/notifications/:id',
    asyncHandler(notificationController.remove.bind(notificationController))
);

// Requester tickets (student | vendor)
router.post(
    '/tickets',
    requireRole('student', 'vendor'),
    asyncHandler(ticketController.create.bind(ticketController))
);
router.get(
    '/tickets',
    requireRole('student', 'vendor'),
    asyncHandler(ticketController.listOwn.bind(ticketController))
);
router.get(
    '/tickets/:id',
    requireRole('student', 'vendor'),
    asyncHandler(ticketController.getOwn.bind(ticketController))
);
router.post(
    '/tickets/:id/messages',
    requireRole('student', 'vendor'),
    asyncHandler(ticketController.replyOwn.bind(ticketController))
);

export default router;
