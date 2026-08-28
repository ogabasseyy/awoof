/**
 * Paystack Webhook Controller
 */

import type { Request, Response } from 'express';
import { completeMarketplaceTransaction } from '../services/payment/checkout.service.js';
import { verifyPaystackWebhookSignature } from '../services/payment/paystack.service.js';
import { appLogger } from '../common/logger.js';

export async function handlePaystackWebhook(req: Request, res: Response): Promise<void> {
    const signature = req.headers['x-paystack-signature'] as string | undefined;
    const rawBody = req.body as Buffer;

    if (!Buffer.isBuffer(rawBody) || !verifyPaystackWebhookSignature(rawBody, signature)) {
        res.status(401).json({ success: false });
        return;
    }

    let event: {
        event?: string;
        data?: { reference?: string; amount?: number };
    };
    try {
        event = JSON.parse(rawBody.toString('utf8'));
    } catch {
        res.status(400).json({ success: false, message: 'Invalid JSON' });
        return;
    }

    if (event.event !== 'charge.success') {
        res.status(200).json({ success: true });
        return;
    }

    const reference = event.data?.reference;
    const amountNaira = (event.data?.amount ?? 0) / 100;

    if (!reference) {
        res.status(200).json({ success: true });
        return;
    }

    try {
        await completeMarketplaceTransaction(reference, amountNaira);
    } catch (error) {
        // Acknowledge so Paystack stops retrying; log for ops / callback verify can still settle
        appLogger.error('Paystack webhook completion failed', {
            reference,
            amountNaira,
            error: error instanceof Error ? error.message : String(error),
        });
    }

    res.status(200).json({ success: true });
}
