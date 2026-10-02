/**
 * Environment Configuration
 * 
 * Centralized environment variable management with validation
 * Follows Single Responsibility Principle - only handles env config
 */

import { z } from 'zod';
import dotenv from 'dotenv';
import { readMicrosoftOidcConfiguration } from '../services/verification/microsoft-oidc.config.js';
import { readStudentSsoConfiguration, retainedSsoAttemptKey, validateStudentSsoFrontendOrigin } from '../services/auth/student-oidc.config.js';

// Load environment variables
// override: false ensures docker-compose env vars take precedence
dotenv.config({ override: false });

/**
 * Environment variable schema
 * Ensures all required variables are present and valid
 */
const envSchema = z.object({
    // Server Configuration
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.string().regex(/^\d+$/).transform(Number).default('5000'),

    // Database Configuration
    DATABASE_URL: z.string().url().optional(),
    DB_HOST: z.string().optional(),
    DB_PORT: z.string().regex(/^\d+$/).transform(Number).optional(),
    DB_NAME: z.string().optional(),
    DB_USER: z.string().optional(),
    DB_PASSWORD: z.string().optional(),

    // Redis Configuration
    REDIS_URL: z.string().url().optional(),
    REDIS_HOST: z.string().default('localhost'),
    REDIS_PORT: z.string().regex(/^\d+$/).transform(Number).default('6379'),
    REDIS_PASSWORD: z.string().optional(),

    // JWT Configuration
    JWT_SECRET: z.string().min(32, 'JWT secret must be at least 32 characters'),
    JWT_REFRESH_SECRET: z.string().min(32, 'JWT refresh secret must be at least 32 characters'),
    JWT_EXPIRY: z.string().default('15m'),
    JWT_REFRESH_EXPIRY: z.string().default('7d'),

    // External Services
    SENDGRID_API_KEY: z.string().optional(),
    AWS_SES_ACCESS_KEY: z.string().optional(),
    AWS_SES_SECRET_KEY: z.string().optional(),
    AWS_SES_REGION: z.string().optional(),
    AWS_S3_BUCKET: z.string().optional(),
    AWS_S3_REGION: z.string().optional(),
    AWS_ACCESS_KEY_ID: z.string().optional(),
    AWS_SECRET_ACCESS_KEY: z.string().optional(),
    WHATSAPP_API_KEY: z.string().optional(),
    WHATSAPP_API_URL: z.string().url().optional().or(z.literal('')),
    PAYSTACK_SECRET_KEY: z.string().optional(),
    PAYSTACK_PUBLIC_KEY: z.string().optional(),
    // Server-only vendor UUID -> merchant account verification credential: the
    // Paystack secret plus the expected test/live environment. The verifier
    // rejects a mismatched provider domain, so a test secret retained where
    // live money was intended cannot settle inventory. No fallback.
    PAYSTACK_MERCHANT_SECRET_KEYS: z.string().default('{}').transform((raw, ctx) => {
        try {
            const parsed = z.record(z.string().uuid(), z.object({
                secret: z.string().trim().min(1),
                domain: z.enum(['test', 'live']),
            })).safeParse(JSON.parse(raw));
            if (parsed.success) {
                // PostgreSQL reports vendor IDs lowercase and the lookup is
                // case-sensitive; normalize here so a valid uppercase UUID in
                // configuration cannot fail closed at runtime without warning.
                const normalized: Record<string, { secret: string; domain: 'test' | 'live' }> = {};
                for (const [vendorId, credential] of Object.entries(parsed.data)) {
                    const key = vendorId.toLowerCase();
                    if (Object.hasOwn(normalized, key)) throw new Error('Duplicate vendor UUID after case normalization');
                    normalized[key] = credential;
                }
                return normalized;
            }
        } catch { /* Report only a generic configuration error; never secret contents. */ }
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Merchant Paystack keys must be a JSON object mapping vendor UUIDs to { secret, domain } credentials' });
        return z.NEVER;
    }),
    // Brevo (Email Service)
    BREVO_API_KEY: z.string().optional(),
    BREVO_FROM_NAME: z.string().optional(),
    EMAIL_FROM: z.string().email().optional(),
    SUPPORT_EMAIL: z.string().email().optional(),

    // Security
    CORS_ORIGIN: z.string().default('http://localhost:3000'),
    RATE_LIMIT_WINDOW_MS: z.string().regex(/^\d+$/).transform(Number).default('900000'), // 15 minutes
    RATE_LIMIT_MAX_REQUESTS: z.string().regex(/^\d+$/).transform(Number).default('100'),

    // Frontend URL (for magic links and redirects)
    FRONTEND_URL: z.string().url().default('http://localhost:3000'),

    // Microsoft OIDC is deliberately opt-in; route wiring remains a later task.
    MICROSOFT_OIDC_ENABLED: z.enum(['true', 'false']).default('false'),
    MICROSOFT_OIDC_TENANT_ID: z.string().optional(),
    MICROSOFT_OIDC_CLIENT_ID: z.string().optional(),
    MICROSOFT_OIDC_CLIENT_SECRET: z.string().optional(),
    MICROSOFT_OIDC_CALLBACK_URL: z.string().optional(),
    MICROSOFT_OIDC_FRONTEND_COMPLETION_URL: z.string().optional(),
    MICROSOFT_ATTEMPT_ENCRYPTION_KEY: z.string().optional(),

    // Student SSO login is deliberately opt-in; providers stay disabled until piloted.
    GOOGLE_LOGIN_ENABLED: z.enum(['true', 'false']).default('false'),
    GOOGLE_LOGIN_CLIENT_ID: z.string().optional(),
    GOOGLE_LOGIN_CLIENT_SECRET: z.string().optional(),
    GOOGLE_LOGIN_CALLBACK_URL: z.string().optional(),
    MICROSOFT_LOGIN_ENABLED: z.enum(['true', 'false']).default('false'),
    MICROSOFT_LOGIN_CLIENT_ID: z.string().optional(),
    MICROSOFT_LOGIN_CLIENT_SECRET: z.string().optional(),
    MICROSOFT_LOGIN_CALLBACK_URL: z.string().optional(),
    STUDENT_SSO_COMPLETION_URL: z.string().optional(),
    STUDENT_SSO_ATTEMPT_KEY: z.string().optional(),
    // Kept separate from provider/OIDC keys so independent recovery remains
    // operable while a school provider is disabled.
    STUDENT_ACCOUNT_RECOVERY_CODE_KEY: z.string().min(32).optional(),
    // Retained previous effective key for dedicated-key rotation. Must be
    // the immediately preceding effective key; see resolveRecoveryCodeKeys.
    STUDENT_ACCOUNT_RECOVERY_PREVIOUS_CODE_KEY: z.string().min(32).optional(),
    // AES-256-GCM recovery OTP outbox keyring. Keys are canonical base64
    // encodings of 32 random bytes; previous key is decrypt-only during
    // rotation and must remain available through the maximum OTP TTL.
    STUDENT_ACCOUNT_RECOVERY_OTP_ENCRYPTION_KEY: z.string().regex(/^[A-Za-z0-9+/]{43}=$/, 'Recovery OTP outbox key must be canonical base64 for 32 bytes').optional(),
    STUDENT_ACCOUNT_RECOVERY_OTP_PREVIOUS_ENCRYPTION_KEY: z.string().regex(/^[A-Za-z0-9+/]{43}=$/, 'Recovery OTP previous outbox key must be canonical base64 for 32 bytes').optional(),
    // Separate rollback gate: linked SSO login remains available when signup is off.
    PASSWORDLESS_STUDENT_SIGNUP_ENABLED: z.enum(['true', 'false']).default('false'),
});

/**
 * Validated environment variables
 */
type Env = z.infer<typeof envSchema>;

let env: Env;

try {
    env = envSchema.parse(process.env);
} catch (error) {
    if (error instanceof z.ZodError) {
        console.error('❌ Invalid environment variables:');
        error.errors.forEach((err) => {
            console.error(`  - ${err.path.join('.')}: ${err.message}`);
        });
        process.exit(1);
    }
    throw error;
}

export function validateMicrosoftFrontendOrigin(frontendUrl: string, oidc: ReturnType<typeof readMicrosoftOidcConfiguration>): void {
    if (oidc.enabled && new URL(frontendUrl).origin !== oidc.frontendCompletionUrl.origin) {
        throw new TypeError('FRONTEND_URL must match the Microsoft completion origin when Microsoft OIDC is enabled');
    }
}

const microsoftOidc = readMicrosoftOidcConfiguration({
    enabled: env.MICROSOFT_OIDC_ENABLED,
    tenantId: env.MICROSOFT_OIDC_TENANT_ID,
    clientId: env.MICROSOFT_OIDC_CLIENT_ID,
    clientSecret: env.MICROSOFT_OIDC_CLIENT_SECRET,
    callbackUrl: env.MICROSOFT_OIDC_CALLBACK_URL,
    frontendCompletionUrl: env.MICROSOFT_OIDC_FRONTEND_COMPLETION_URL,
});
validateMicrosoftFrontendOrigin(env.FRONTEND_URL, microsoftOidc);

const studentSso = readStudentSsoConfiguration({
    googleEnabled: env.GOOGLE_LOGIN_ENABLED,
    googleClientId: env.GOOGLE_LOGIN_CLIENT_ID,
    googleClientSecret: env.GOOGLE_LOGIN_CLIENT_SECRET,
    googleCallbackUrl: env.GOOGLE_LOGIN_CALLBACK_URL,
    microsoftEnabled: env.MICROSOFT_LOGIN_ENABLED,
    microsoftClientId: env.MICROSOFT_LOGIN_CLIENT_ID,
    microsoftClientSecret: env.MICROSOFT_LOGIN_CLIENT_SECRET,
    microsoftCallbackUrl: env.MICROSOFT_LOGIN_CALLBACK_URL,
    completionUrl: env.STUDENT_SSO_COMPLETION_URL,
    attemptKey: env.STUDENT_SSO_ATTEMPT_KEY,
});
validateStudentSsoFrontendOrigin(env.FRONTEND_URL, studentSso);

const dedicatedRecoveryCodeKey = env.STUDENT_ACCOUNT_RECOVERY_CODE_KEY ?? null;
const retainedRecoveryCodeKey = retainedSsoAttemptKey(env.STUDENT_SSO_ATTEMPT_KEY);
const explicitPreviousRecoveryCodeKey = env.STUDENT_ACCOUNT_RECOVERY_PREVIOUS_CODE_KEY ?? null;

/**
 * Resolve the effective recovery-code digest keys. The dedicated key issues
 * new digests; verification also accepts one previous key so key changes
 * never strand active codes. Rotation for K1 -> K2 is staged across two
 * fully completed deploys: promoting the write key in one step would let
 * new replicas issue K2 digests that old replicas cannot verify yet.
 * Stage 1 (verify-only): set the explicit previous key to K2 while the
 * dedicated key stays K1, and deploy everywhere; every replica still
 * writes K1 but already verifies K2. Stage 2 (promote): set the dedicated
 * key to K2 with the explicit previous key at K1, and deploy; K2 digests
 * are now verifiable on every replica from the first write. Retire the
 * explicit previous key only after every code enrolled under K1 has been
 * re-enrolled (replacement/activation digests always use the current key).
 * The explicit previous key must be the immediately preceding effective
 * key: codes enrolled under any older key are not verifiable, so re-enroll
 * pre-dedicated-key codes before rotating the dedicated key. Adding the
 * first dedicated key follows the same two stages through the explicit
 * previous key (stage 1 with the dedicated key still unset, so issuance
 * stays on the retained SSO attempt key); once set, the established SSO
 * attempt key is retained automatically as the fallback.
 */
export function resolveRecoveryCodeKeys(input: { dedicated: string | null; retained: string | null; explicitPrevious: string | null }): { codeKey: string | null; previousCodeKey: string | null } {
    const codeKey = input.dedicated ?? input.retained;
    if (input.explicitPrevious && input.explicitPrevious !== codeKey) return { codeKey, previousCodeKey: input.explicitPrevious };
    if (input.dedicated && input.retained && input.dedicated !== input.retained) return { codeKey, previousCodeKey: input.retained };
    return { codeKey, previousCodeKey: null };
}

const recoveryCodeKeys = resolveRecoveryCodeKeys({
    dedicated: dedicatedRecoveryCodeKey,
    retained: retainedRecoveryCodeKey,
    explicitPrevious: explicitPreviousRecoveryCodeKey,
});

/**
 * Configuration object
 * Provides typed access to environment variables
 */
export const config = {
    // Server
    env: env.NODE_ENV,
    port: env.PORT,
    isDevelopment: env.NODE_ENV === 'development',
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',

    // Database
    database: {
        url: env.DATABASE_URL,
        host: env.DB_HOST,
        port: env.DB_PORT || 5432,
        name: env.DB_NAME,
        user: env.DB_USER,
        password: env.DB_PASSWORD,
    },

    // Redis
    redis: {
        url: env.REDIS_URL,
        host: env.REDIS_HOST,
        port: env.REDIS_PORT,
        password: env.REDIS_PASSWORD,
    },

    // JWT
    jwt: {
        secret: env.JWT_SECRET,
        refreshSecret: env.JWT_REFRESH_SECRET,
        expiry: env.JWT_EXPIRY,
        refreshExpiry: env.JWT_REFRESH_EXPIRY,
    },

    // External Services
    email: {
        provider: env.SENDGRID_API_KEY ? 'sendgrid' : 'ses',
        sendgrid: {
            apiKey: env.SENDGRID_API_KEY,
        },
        ses: {
            accessKey: env.AWS_SES_ACCESS_KEY,
            secretKey: env.AWS_SES_SECRET_KEY,
            region: env.AWS_SES_REGION || 'us-east-1',
        },
    },

    whatsapp: {
        apiKey: env.WHATSAPP_API_KEY,
        apiUrl: env.WHATSAPP_API_URL || undefined,
    },

    paystack: {
        secretKey: env.PAYSTACK_SECRET_KEY,
        publicKey: env.PAYSTACK_PUBLIC_KEY,
        merchantSecretKeys: env.PAYSTACK_MERCHANT_SECRET_KEYS,
    },

    aws: {
        s3: {
            bucket: env.AWS_S3_BUCKET,
            region: env.AWS_S3_REGION || 'us-east-1',
        },
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },

    // Security
    cors: {
        origin: env.CORS_ORIGIN.split(','),
    },
    rateLimit: {
        windowMs: env.RATE_LIMIT_WINDOW_MS,
        maxRequests: env.RATE_LIMIT_MAX_REQUESTS,
    },

    // Frontend
    frontend: {
        url: env.FRONTEND_URL,
    },

    microsoftOidc,
    studentSso,
    passwordlessStudentSignupEnabled: env.PASSWORDLESS_STUDENT_SIGNUP_ENABLED === 'true',
    studentAccountRecovery: {
        // Recovery-code digests are versioned HMACs; see
        // resolveRecoveryCodeKeys for the rotation procedure. Never rotate
        // the SSO attempt key itself while fallback-verified codes may
        // exist: re-enroll codes first. Disabling a provider must not remove
        // the retained key, so the fallback resolves from the raw
        // environment value independently of provider enablement instead of
        // the nulled SSO configuration.
        ...recoveryCodeKeys,
        otpOutboxEncryptionKey: env.STUDENT_ACCOUNT_RECOVERY_OTP_ENCRYPTION_KEY ?? null,
        previousOtpOutboxEncryptionKey: env.STUDENT_ACCOUNT_RECOVERY_OTP_PREVIOUS_ENCRYPTION_KEY ?? null,
    },
    // This trusted frontend setting is intentionally independent from OIDC
    // credentials so owner/history routes can remain available while issuance
    // is disabled.
    microsoftVerification: {
        frontendOrigin: new URL(env.FRONTEND_URL).origin,
        attemptEncryptionKey: env.MICROSOFT_ATTEMPT_ENCRYPTION_KEY,
    },
} as const;

export default config;
