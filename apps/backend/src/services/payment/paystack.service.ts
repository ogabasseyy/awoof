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
    const expected = Buffer.from(hash, 'hex');
    const received = Buffer.from(signatureHeader, 'hex');
    return received.length === expected.length && crypto.timingSafeEqual(received, expected);
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

function requirePaystackSecret(): string {
    if (!config.paystack.secretKey) {
        throw new BadRequestError('Paystack secret key not configured');
    }
    return config.paystack.secretKey;
}

function paystackAuthHeaders() {
    return { Authorization: `Bearer ${requirePaystackSecret()}` };
}

function paystackErrorMessage(error: unknown, fallback: string): string {
    if (axios.isAxiosError(error)) {
        const msg = error.response?.data?.message;
        if (typeof msg === 'string' && msg.trim()) return msg;
    }
    return fallback;
}

export async function listPaystackBanks(): Promise<{ name: string; code: string }[]> {
    try {
        const response = await axios.get('https://api.paystack.co/bank', {
            headers: paystackAuthHeaders(),
            params: { country: 'nigeria', currency: 'NGN' },
        });
        const rows = response.data?.data;
        if (!Array.isArray(rows)) {
            throw new BadRequestError('Failed to load banks from Paystack');
        }
        return rows
            .map((b: { name?: string; code?: string }) => ({
                name: String(b.name ?? ''),
                code: String(b.code ?? ''),
            }))
            .filter((b: { name: string; code: string }) => b.name && b.code)
            .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));
    } catch (error: unknown) {
        if (error instanceof BadRequestError) throw error;
        throw new BadRequestError(paystackErrorMessage(error, 'Failed to load banks from Paystack'));
    }
}

export async function resolvePaystackAccount(
    bankCode: string,
    accountNumber: string
): Promise<{ accountNumber: string; accountName: string }> {
    try {
        const response = await axios.get('https://api.paystack.co/bank/resolve', {
            headers: paystackAuthHeaders(),
            params: {
                bank_code: bankCode,
                account_number: accountNumber,
            },
        });
        const data = response.data?.data;
        if (!data?.account_name) {
            throw new BadRequestError('Could not resolve account name');
        }
        return {
            accountNumber: String(data.account_number ?? accountNumber),
            accountName: String(data.account_name),
        };
    } catch (error: unknown) {
        if (error instanceof BadRequestError) throw error;
        throw new BadRequestError(paystackErrorMessage(error, 'Could not resolve bank account'));
    }
}

export async function createPaystackSubaccount(params: {
    businessName: string;
    bankCode: string;
    accountNumber: string;
    percentageCharge: number;
}): Promise<{ subaccountCode: string }> {
    try {
        const response = await axios.post(
            'https://api.paystack.co/subaccount',
            {
                business_name: params.businessName,
                bank_code: params.bankCode,
                account_number: params.accountNumber,
                percentage_charge: params.percentageCharge,
            },
            { headers: paystackAuthHeaders() }
        );
        const code = response.data?.data?.subaccount_code;
        if (!code) {
            throw new BadRequestError('Paystack did not return a subaccount code');
        }
        return { subaccountCode: String(code) };
    } catch (error: unknown) {
        if (error instanceof BadRequestError) throw error;
        throw new BadRequestError(paystackErrorMessage(error, 'Failed to create Paystack subaccount'));
    }
}

export async function updatePaystackSubaccount(
    subaccountCode: string,
    params: {
        businessName: string;
        bankCode: string;
        accountNumber: string;
        percentageCharge: number;
    }
): Promise<{ subaccountCode: string }> {
    try {
        const response = await axios.put(
            `https://api.paystack.co/subaccount/${encodeURIComponent(subaccountCode)}`,
            {
                business_name: params.businessName,
                bank_code: params.bankCode,
                settlement_bank: params.bankCode,
                account_number: params.accountNumber,
                percentage_charge: params.percentageCharge,
            },
            { headers: paystackAuthHeaders() }
        );
        const code = response.data?.data?.subaccount_code ?? subaccountCode;
        return { subaccountCode: String(code) };
    } catch (error: unknown) {
        if (error instanceof BadRequestError) throw error;
        throw new BadRequestError(paystackErrorMessage(error, 'Failed to update Paystack subaccount'));
    }
}
