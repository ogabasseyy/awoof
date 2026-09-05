/**
 * Notification Service — user-scoped in-app notifications
 */

import { db } from '../../config/database.js';

export type NotificationType = 'info' | 'success' | 'warning' | 'error';

export interface NotifyParams {
    title: string;
    message: string;
    type?: NotificationType;
    kind?: string;
    metadata?: Record<string, unknown>;
}

export class NotificationService {
    public static async notifyUser(userId: string, params: NotifyParams): Promise<void> {
        const { title, message, type = 'info', kind, metadata } = params;
        await db.query(
            `INSERT INTO notifications (user_id, title, message, type, kind, metadata)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
                userId,
                title,
                message,
                type,
                kind ?? null,
                metadata ? JSON.stringify(metadata) : null,
            ]
        );
    }

    public static async notifyMany(userIds: string[], params: NotifyParams): Promise<void> {
        const unique = [...new Set(userIds.filter(Boolean))];
        for (const userId of unique) {
            await this.notifyUser(userId, params);
        }
    }

    /** Resolve student profile id → user id, then notify */
    public static async notifyStudentByProfileId(
        studentId: string,
        params: NotifyParams
    ): Promise<void> {
        const result = await db.query(
            `SELECT user_id FROM students WHERE id = $1`,
            [studentId]
        );
        if (result.rows.length === 0) return;
        await this.notifyUser(result.rows[0].user_id, params);
    }

    public static async notifyPurchaseConfirmation(
        studentId: string,
        productName: string,
        amount: number,
        discount: number,
        transactionId: string
    ): Promise<void> {
        await this.notifyStudentByProfileId(studentId, {
            title: 'Purchase confirmed',
            message: `Your purchase of ${productName} is confirmed. Receipt sent to your email.`,
            type: 'success',
            kind: 'purchase',
            metadata: { transactionId, productName, amount, discount },
        });
    }

    public static async notifySavingsMilestone(
        studentId: string,
        totalSavings: number
    ): Promise<void> {
        const milestones = [1000, 5000, 10000, 25000, 50000, 100000];
        const milestone = milestones.filter((m) => totalSavings >= m).at(-1);
        if (!milestone) return;
        // Claim and publish atomically: concurrent purchases and outbox retries
        // must not announce the same milestone twice, even if an inbox is cleared.
        await db.query(
            `WITH claimed AS (
                INSERT INTO savings_milestones (user_id, milestone)
                SELECT user_id, $2 FROM students WHERE id = $1
                ON CONFLICT (user_id, milestone) DO NOTHING
                RETURNING user_id
             )
             INSERT INTO notifications (user_id, title, message, type, kind, metadata)
             SELECT user_id, 'Savings milestone', $3, 'success', 'savings', $4
             FROM claimed`,
            [studentId, milestone,
                `Congratulations! You have saved over ₦${milestone.toLocaleString()}`,
                JSON.stringify({ milestone, totalSavings })]
        );
    }

    public static async notifyVerificationSuccess(studentId: string): Promise<void> {
        await this.notifyStudentByProfileId(studentId, {
            title: 'Verification successful',
            message: 'Your student verification has been completed successfully!',
            type: 'success',
            kind: 'verification',
            metadata: { event: 'verification_success' },
        });
    }

    public static async notifyVendorNewOrder(params: {
        vendorUserId: string;
        productName: string;
        amount: number;
        transactionId: string;
    }): Promise<void> {
        await this.notifyUser(params.vendorUserId, {
            title: 'New order',
            message: `${params.productName} — ₦${params.amount.toLocaleString()}`,
            type: 'success',
            kind: 'order',
            metadata: {
                transactionId: params.transactionId,
                productName: params.productName,
                amount: params.amount,
            },
        });
    }

    public static async notifyVendorPayoutEnabled(vendorUserId: string): Promise<void> {
        await this.notifyUser(vendorUserId, {
            title: 'Split payments enabled',
            message: 'Your payout account is set. Marketplace sales can split to your bank via Paystack.',
            type: 'success',
            kind: 'payout',
        });
    }
}
