/**
 * Paystack Webhook Controller
 */

import type { Request, Response } from 'express';
import { completeMarketplaceTransaction } from '../services/payment/checkout.service.js';
import { verifyPaystackWebhookSignature } from '../services/payment/paystack.service.js';

export async function handlePaystackWebhook(req: Request, res: Response): Promise<void> {
    const signature = req.headers['x-paystack-signature'] as string | undefined;
    const rawBody = req.body as Buffer;

    if (!Buffer.isBuffer(rawBody) || !verifyPaystackWebhookSignature(rawBody, signature)) {
        res.status(401).json({ success: false });
        return;
    }

    const event = JSON.parse(rawBody.toString('utf8')) as {
        event?: string;
        data?: { reference?: string; amount?: number };
    };

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

    await completeMarketplaceTransaction(reference, amountNaira);
    res.status(200).json({ success: true });
}
