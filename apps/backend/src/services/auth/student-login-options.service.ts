import { createHmac } from 'node:crypto';
import {
    BadRequestError,
    RateLimitError,
    ServiceUnavailableError,
} from '../../common/errors/AppError.js';
import { normalizeMailbox } from '../verification/eligibility-policy.service.js';
import type { LoginOptions, LoginProvider } from './student-sso.types.js';

export const STUDENT_LOGIN_OPTIONS_MAX_EMAIL_LENGTH = 254;
export const STUDENT_DISCOVERY_QUOTA = { max: 60, windowMs: 10 * 60 * 1000 };
export const STUDENT_SSO_START_IP_QUOTA = { max: 10, windowMs: 10 * 60 * 1000 };
export const STUDENT_SSO_START_MAILBOX_QUOTA = { max: 5, windowMs: 10 * 60 * 1000 };

const DISCOVERY_KEY_PREFIX = 'student-sso:discovery:v1:';
const START_IP_KEY_PREFIX = 'student-sso:start:ip:v1:';
const START_MAILBOX_KEY_PREFIX = 'student-sso:start:mailbox:v1:';

/**
 * Read-only discovery join: active universities, enabled unexpired login
 * policies, and active domain mappings. It never touches users, students,
 * linked identities, legacy mailbox domains, or benefit evidence.
 */
export const STUDENT_LOGIN_OPTIONS_QUERY = `
SELECT p.provider
FROM institution_login_policies p
JOIN universities u ON u.id = p.university_id AND u.is_active
JOIN institution_login_domain_providers dp
  ON dp.policy_id = p.id
 AND dp.university_id = p.university_id
 AND dp.provider = p.provider
JOIN institution_login_domains d
  ON d.domain = dp.domain
 AND d.university_id = dp.university_id
 AND d.is_active
WHERE p.enabled
  AND p.approved_until IS NOT NULL
  AND p.approved_until > clock_timestamp()
  AND d.domain = $1
  AND p.provider = ANY($2)
`.trim();

export type LoginOptionsQuery = (
    text: string,
    params: [domain: string, providers: LoginProvider[]],
) => Promise<{ rows: Array<{ provider: string }> }>;

/** Trim/lowercase mailbox normalization; preserves plus suffixes and dots. */
export function normalizeStudentLoginEmail(input: unknown): string {
    if (typeof input !== 'string' || input.length === 0 || input.length > STUDENT_LOGIN_OPTIONS_MAX_EMAIL_LENGTH) {
        throw new BadRequestError('Invalid email address');
    }
    try {
        return normalizeMailbox(input);
    } catch {
        throw new BadRequestError('Invalid email address');
    }
}

export async function resolveStudentLoginOptions(
    query: LoginOptionsQuery,
    input: { email: unknown; enabledProviders: LoginProvider[] },
): Promise<LoginOptions> {
    const passwordOnly: LoginOptions = { password: true, providers: [], registration: true, recovery: true };
    const mailbox = normalizeStudentLoginEmail(input.email);
    if (input.enabledProviders.length === 0) return passwordOnly;
    const domain = mailbox.slice(mailbox.lastIndexOf('@') + 1);
    const rows = await query(STUDENT_LOGIN_OPTIONS_QUERY, [domain, [...input.enabledProviders]]);
    const ready = new Set(input.enabledProviders);
    const providers = [...new Set(rows.rows.map((row) => row.provider))]
        .filter((provider): provider is LoginProvider => provider === 'google' || provider === 'microsoft')
        .filter((provider) => ready.has(provider))
        .sort();
    return { password: true, providers, registration: true, recovery: true };
}

export type QuotaStore = {
    increment(key: string, windowMs: number): Promise<number>;
};

type RedisEvalClient = {
    eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
};

const QUOTA_SCRIPT = `local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return current`;

/** Bounded expiring counters: one Redis key per quota subject, auto-expired. */
export function createRedisQuotaStore(client: RedisEvalClient): QuotaStore {
    return {
        increment: async (key, windowMs) => {
            const reply = await client.eval(QUOTA_SCRIPT, 1, key, String(windowMs));
            if (typeof reply !== 'number' || !Number.isInteger(reply)) {
                throw new Error('Quota storage returned an unexpected reply');
            }
            return reply;
        },
    };
}

async function spendQuota(store: QuotaStore, key: string, quota: { max: number; windowMs: number }, message: string): Promise<void> {
    let count: number;
    try {
        count = await store.increment(key, quota.windowMs);
    } catch {
        // A quota outage must never become unlimited access: discovery and
        // SSO start stay closed with a retryable 503 until storage recovers.
        throw new ServiceUnavailableError('Student login is temporarily unavailable. Please try again.');
    }
    if (count > quota.max) throw new RateLimitError(message);
}

/** 60 discovery requests per proxy-aware client IP per 10 minutes. */
export async function checkDiscoveryQuota(store: QuotaStore, clientIp: string): Promise<void> {
    await spendQuota(store, `${DISCOVERY_KEY_PREFIX}${clientIp}`, STUDENT_DISCOVERY_QUOTA, 'Too many login discovery requests. Please try again later.');
}

function attemptKeyBytes(value: string): Buffer {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
        throw new TypeError('Student SSO attempt key is invalid');
    }
    const key = Buffer.from(value, 'base64url');
    if (key.byteLength !== 32) throw new TypeError('Student SSO attempt key must be 32 bytes');
    return key;
}

/** Mailbox quota subject: HMAC-SHA256 keyed by the shared attempt key. Raw mailboxes never enter quota storage. */
export function hmacStudentMailbox(mailbox: string, attemptKey: string): string {
    return createHmac('sha256', attemptKeyBytes(attemptKey)).update(mailbox, 'utf8').digest('base64url');
}

/** SSO start budgets (wired by the B3 start route): 10 per IP, 5 per mailbox HMAC. */
export async function checkSsoStartQuota(
    store: QuotaStore,
    clientIp: string,
    mailbox: string,
    attemptKey: string,
): Promise<void> {
    await spendQuota(store, `${START_IP_KEY_PREFIX}${clientIp}`, STUDENT_SSO_START_IP_QUOTA, 'Too many SSO start requests. Please try again later.');
    await spendQuota(
        store,
        `${START_MAILBOX_KEY_PREFIX}${hmacStudentMailbox(mailbox, attemptKey)}`,
        STUDENT_SSO_START_MAILBOX_QUOTA,
        'Too many SSO start requests for this email. Please try again later.',
    );
}
