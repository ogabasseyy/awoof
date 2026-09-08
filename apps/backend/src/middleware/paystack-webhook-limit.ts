import rateLimit from 'express-rate-limit';
import { verifyPaystackWebhookSignature } from '../services/payment/paystack.service.js';

// Authenticate the bounded raw body before deciding whether to charge the
// abuse quota. Authentic provider deliveries never share the user/IP quota.
export const paystackWebhookLimiter = rateLimit({
    windowMs: 60_000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => Buffer.isBuffer(req.body) && verifyPaystackWebhookSignature(
        req.body, typeof req.headers['x-paystack-signature'] === 'string' ? req.headers['x-paystack-signature'] : undefined),
});
