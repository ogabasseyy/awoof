/**
 * Environment Configuration
 * 
 * Centralized environment variable management with validation
 * Follows Single Responsibility Principle - only handles env config
 */

import { z } from 'zod';
import dotenv from 'dotenv';

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
    // Brevo (Email Service)
    BREVO_API_KEY: z.string().optional(),
    BREVO_FROM_NAME: z.string().optional(),
    EMAIL_FROM: z.string().email().optional(),

    // Monitoring
    SENTRY_DSN: z.string().url().optional().or(z.literal('')),

    // Security
    CORS_ORIGIN: z.string().default('http://localhost:3000'),
    RATE_LIMIT_WINDOW_MS: z.string().regex(/^\d+$/).transform(Number).default('900000'), // 15 minutes
    RATE_LIMIT_MAX_REQUESTS: z.string().regex(/^\d+$/).transform(Number).default('100'),

    // Frontend URL (for magic links and redirects)
    FRONTEND_URL: z.string().url().default('http://localhost:3000'),
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
    },

    aws: {
        s3: {
            bucket: env.AWS_S3_BUCKET,
            region: env.AWS_S3_REGION || 'us-east-1',
        },
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },

    // Monitoring
    sentry: {
        dsn: env.SENTRY_DSN || undefined,
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
} as const;

export default config;

