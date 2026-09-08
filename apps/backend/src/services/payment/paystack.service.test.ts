import assert from 'node:assert/strict';
import test from 'node:test';
import axios from 'axios';
import { config } from '../../config/env.js';
import { createPaystackSubaccount, updatePaystackSubaccount, PaystackMutationRejectedError, isDefinitiveInitializationRejection, resolvePaystackAccount } from './paystack.service.js';

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
