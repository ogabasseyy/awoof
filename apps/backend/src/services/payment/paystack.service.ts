/**
 * Paystack Service
 * 
 * Handles Paystack payment validation and verification
 * Follows Single Responsibility Principle - only handles Paystack operations
 */

import axios from 'axios';
import crypto from 'crypto';
import { config } from '../../config/env.js';
import { BadRequestError } from '../../common/errors/AppError.js';

/**
 * Verify a Paystack payment reference
 */
export async function verifyPaystackPayment(
    paymentReference: string
): Promise<{
    verified: boolean;
    amount?: number;
    status?: string;
    customer?: {
        email: string;
        name?: string;
    };
    metadata?: Record<string, unknown>;
    error?: string;
}> {
    if (!config.paystack.secretKey) {
        throw new BadRequestError('Paystack secret key not configured');
    }

    try {
        const response = await axios.get(
            `https://api.paystack.co/transaction/verify/${paymentReference}`,
            {
                headers: {
                    Authorization: `Bearer ${config.paystack.secretKey}`,
                },
            }
        );

        const data = response.data.data;

        if (!data || data.status !== 'success') {
            return {
                verified: false,
                error: 'Payment not successful',
            };
        }

        return {
            verified: true,
            amount: data.amount / 100, // Paystack returns amount in kobo, convert to naira
            status: data.status,
            customer: {
                email: data.customer?.email || '',
                name: data.customer?.first_name || data.customer?.last_name || undefined,
            },
            metadata: data.metadata || {},
        };
    } catch (error: unknown) {
        if (axios.isAxiosError(error)) {
            if (error.response?.status === 404) {
                return {
                    verified: false,
                    error: 'Payment reference not found',
                };
            }
            return {
                verified: false,
                error: error.response?.data?.message || 'Failed to verify payment',
            };
        }
        return {
            verified: false,
            error: 'Unknown error verifying payment',
        };
    }
}

/**
 * Check if a payment reference has already been used
 */
export async function checkDuplicatePayment(
    _paymentReference: string
): Promise<boolean> {
    // This will be checked in the database by the controller
    // This function is here for potential future use (e.g., caching)
    return false;
}

export function verifyPaystackWebhookSignature(
    rawBody: Buffer,
    signatureHeader: string | undefined
): boolean {
    const secret = config.paystack.webhookSecret || config.paystack.secretKey;
    if (!secret || !signatureHeader) {
        return false;
    }
    const hash = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
    return hash === signatureHeader;
}

export function generatePaystackReference(): string {
    return `awoof_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

export async function initializePaystackTransaction(params: {
    email: string;
    amountKobo: number;
    reference: string;
    callbackUrl: string;
    metadata: Record<string, unknown>;
    subaccountCode?: string | null;
    transactionChargeKobo?: number;
}): Promise<{ authorizationUrl: string; accessCode: string }> {
    if (!config.paystack.secretKey) {
        throw new BadRequestError('Paystack secret key not configured');
    }

    const body: Record<string, unknown> = {
        email: params.email,
        amount: params.amountKobo,
        reference: params.reference,
        callback_url: params.callbackUrl,
        metadata: params.metadata,
    };

    if (params.subaccountCode) {
        body.subaccount = params.subaccountCode;
        body.transaction_charge = params.transactionChargeKobo ?? 0;
        body.bearer = 'subaccount';
    }

    const response = await axios.post(
        'https://api.paystack.co/transaction/initialize',
        body,
        {
            headers: {
                Authorization: `Bearer ${config.paystack.secretKey}`,
            },
        }
    );

    const data = response.data?.data;
    if (!data?.authorization_url) {
        throw new BadRequestError('Paystack initialize failed');
    }

    return {
        authorizationUrl: data.authorization_url,
        accessCode: data.access_code,
    };
}

