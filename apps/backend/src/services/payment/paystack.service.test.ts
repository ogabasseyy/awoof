import assert from 'node:assert/strict';
import test from 'node:test';
import axios from 'axios';
import { config } from '../../config/env.js';
import { createPaystackSubaccount, updatePaystackSubaccount, PaystackMutationRejectedError, isDefinitiveInitializationRejection, resolvePaystackAccount, verifyMerchantPaystackPayment } from './paystack.service.js';

test('initialization distinguishes rejected requests from ambiguous provider outcomes', () => {
    const error = (status: number, message: string, rejected = true) => ({ isAxiosError: true, response: { status, data: { status: !rejected, message } } });
    for (const status of [400, 401, 403, 404, 422]) {
        assert.equal(isDefinitiveInitializationRejection(error(status, 'Invalid subaccount')), true);
    }
    for (const status of [408, 409, 429, 500, 502, 504]) {
        assert.equal(isDefinitiveInitializationRejection(error(status, 'Request failed')), false);
    }
    assert.equal(isDefinitiveInitializationRejection(error(400, 'Duplicate Transaction Reference')), false);
    assert.equal(isDefinitiveInitializationRejection(error(400, 'Reference has already been used')), false);
    assert.equal(isDefinitiveInitializationRejection(new Error('timeout')), false);
});

test('bank resolution has a deadline and returns a retryable service error on timeout', async () => {
    const original = axios.get;
    const key = config.paystack.secretKey;
    Object.assign(config.paystack, { secretKey: 'synthetic-key' });
    axios.get = (async (_url: unknown, options: { timeout?: number; signal?: AbortSignal }) => {
        assert.equal(options.timeout, 15000);
        assert.ok(options.signal);
        throw { isAxiosError: true, code: 'ERR_CANCELED' };
    }) as typeof axios.get;
    try {
        await assert.rejects(resolvePaystackAccount('synthetic', '0000000000'), { statusCode: 503 });
    } finally {
        axios.get = original;
        Object.assign(config.paystack, { secretKey: key });
    }
});


test('payout mutations expose definitive rejection separately from an ambiguous timeout', async () => {
    const originalPost = axios.post; const originalPut = axios.put;
    const key = config.paystack.secretKey;
    Object.assign(config.paystack, { secretKey: 'synthetic-key' });
    const input = { businessName: 'Synthetic', bankCode: '000', accountNumber: '0000000000', percentageCharge: 0 };
    try {
        for (const definitive of [true, false]) {
            const reject = async () => { throw definitive ? { isAxiosError: true, response: { status: 400, data: { status: false, message: 'Invalid account' } } } : { isAxiosError: true, code: 'ECONNABORTED' }; };
            axios.post = reject as typeof axios.post; axios.put = reject as typeof axios.put;
            for (const invoke of [() => createPaystackSubaccount(input), () => updatePaystackSubaccount('ACCT_synthetic', input)]) {
                await assert.rejects(invoke(), (error) => (error instanceof PaystackMutationRejectedError) === definitive);
            }
        }
    } finally { axios.post = originalPost; axios.put = originalPut; Object.assign(config.paystack, { secretKey: key }); }
});


test('merchant verification selects only authenticated vendor credentials and validates provider shape', async () => {
    const originalGet = axios.get;
    const oldKeys = config.paystack.merchantSecretKeys;
    const vendor = '00000000-0000-4000-8000-000000000001';
    Object.assign(config.paystack, { merchantSecretKeys: { [vendor]: 'synthetic-merchant-key' } });
    let calls = 0;
    let transaction: Record<string, unknown> = { status: 'success', reference: 'ref/test', amount: 8000, currency: 'NGN', metadata: {} };
    axios.get = (async (url: string, options: { timeout: number; signal: AbortSignal; headers: Record<string, string> }) => {
        calls++;
        assert.equal(url, 'https://api.paystack.co/transaction/verify/ref%2Ftest');
        assert.equal(options.headers.Authorization, 'Bearer synthetic-merchant-key');
        assert.equal(options.timeout, 15000);
        assert.ok(options.signal);
        return { data: { status: true, data: transaction } };
    }) as typeof axios.get;
    try {
        await assert.rejects(verifyMerchantPaystackPayment('00000000-0000-4000-8000-000000000002', 'ref/test'), /not configured/);
        assert.equal(calls, 0);
        assert.deepEqual(await verifyMerchantPaystackPayment(vendor, 'ref/test'), {
            verified: true, amountKobo: 8000, currency: 'NGN', metadata: {},
        });
        for (const invalid of [
            { status: 'pending' }, { status: 'failed' }, { reference: undefined }, { reference: 'wrong-reference' }, { currency: 'USD' },
            { amount: 80.5 }, { amount: '8000' }, { amount: 0 },
            { amount: Number.MAX_SAFE_INTEGER + 1 }, { metadata: null }, { metadata: [] },
        ]) {
            transaction = { status: 'success', reference: 'ref/test', amount: 8000, currency: 'NGN', metadata: {}, ...invalid };
            assert.equal((await verifyMerchantPaystackPayment(vendor, 'ref/test')).verified, false);
        }
        axios.get = (async () => { throw new Error('synthetic-secret-account-detail'); }) as typeof axios.get;
        assert.deepEqual(await verifyMerchantPaystackPayment(vendor, 'ref/test'), { verified: false, error: 'Merchant payment verification failed' });
        axios.get = (async () => { throw { isAxiosError: true, response: { status: 404, data: { message: 'not found' } } }; }) as typeof axios.get;
        assert.deepEqual(await verifyMerchantPaystackPayment(vendor, 'ref/test'), { verified: false, error: 'Merchant payment verification failed' });
        for (const outage of [{ isAxiosError: true, code: 'ECONNABORTED' }, { isAxiosError: true, code: 'ERR_CANCELED' }, { isAxiosError: true, response: { status: 502, data: {} } }, { isAxiosError: true, response: { status: 503, data: {} } }]) {
            axios.get = (async () => { throw outage; }) as typeof axios.get;
            await assert.rejects(verifyMerchantPaystackPayment(vendor, 'ref/test'), { statusCode: 503 });
        }
    } finally {
        axios.get = originalGet;
        Object.assign(config.paystack, { merchantSecretKeys: oldKeys });
    }
});
