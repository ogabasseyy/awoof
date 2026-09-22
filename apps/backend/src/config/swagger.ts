/**
 * Swagger/OpenAPI Configuration
 * 
 * API documentation setup for product owner visibility
 */

import swaggerJsdoc from 'swagger-jsdoc';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './env.js';

const options: swaggerJsdoc.Options = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'Awoof Backend API',
            version: '1.0.0',
            description: `
# Awoof Backend API Documentation

This API powers the Awoof student discount marketplace platform.

## Features Implemented

### Authentication & User Management
- User registration (students and vendors)
- Login with JWT tokens
- Token refresh mechanism
- Forgot password with OTP via email
- Password reset with OTP verification
- Update password (requires old password)
- User profile management

### Student Management
- Student profile retrieval and updates
- Purchase history tracking
- Savings statistics

## API Structure

All endpoints are prefixed with \`/api\`:
- Authentication: \`/api/auth/*\`
- Students: \`/api/students/*\`

## Authentication

Most endpoints require JWT authentication. Include the token in the Authorization header:
\`\`\`
Authorization: Bearer <your-access-token>
\`\`\`

Access tokens expire in 15 minutes. Use the refresh token endpoint to get a new access token.
            `,
            contact: {
                name: 'Awoof Development Team',
                email: 'dev@awoof.com',
            },
            license: {
                name: 'Proprietary',
            },
        },
        servers: [
            {
                url: `http://localhost:${config.port}`,
                description: 'Development server',
            },
            {
                url: 'https://api.awoof.tech',
                description: 'Production server',
            },
        ],
        components: {
            securitySchemes: {
                bearerAuth: {
                    type: 'http',
                    scheme: 'bearer',
                    bearerFormat: 'JWT',
                    description: 'JWT access token. Get token from /api/auth/login',
                },
            },
            schemas: {
                Error: {
                    type: 'object',
                    properties: {
                        success: {
                            type: 'boolean',
                            example: false,
                        },
                        error: {
                            type: 'object',
                            properties: {
                                message: {
                                    type: 'string',
                                    example: 'Error message',
                                },
                                code: {
                                    type: 'string',
                                    example: 'ERROR_CODE',
                                },
                                statusCode: {
                                    type: 'number',
                                    example: 400,
                                },
                                details: {
                                    type: 'object',
                                },
                            },
                        },
                    },
                },
                SuccessResponse: {
                    type: 'object',
                    properties: {
                        success: {
                            type: 'boolean',
                            example: true,
                        },
                        message: {
                            type: 'string',
                            example: 'Operation successful',
                        },
                        data: {
                            type: 'object',
                        },
                    },
                },
                User: {
                    type: 'object',
                    properties: {
                        id: {
                            type: 'string',
                            format: 'uuid',
                            example: '47a4f77e-3365-4c3f-9932-71459f2b058c',
                        },
                        email: {
                            type: 'string',
                            format: 'email',
                            example: 'student@example.com',
                        },
                        role: {
                            type: 'string',
                            enum: ['student', 'vendor', 'admin'],
                            example: 'student',
                        },
                        verificationStatus: {
                            type: 'string',
                            enum: ['unverified', 'verified', 'expired'],
                            example: 'verified',
                        },
                    },
                },
                Tokens: {
                    type: 'object',
                    properties: {
                        accessToken: {
                            type: 'string',
                            example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
                        },
                        refreshToken: {
                            type: 'string',
                            example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
                        },
                    },
                },
                StudentProfile: {
                    type: 'object',
                    properties: {
                        name: {
                            type: 'string',
                            example: 'John Doe',
                        },
                        university: {
                            type: 'string',
                            example: 'University of Lagos',
                        },
                        registrationNumber: {
                            type: 'string',
                            example: '2019/12345',
                        },
                        phoneNumber: {
                            type: 'string',
                            example: '+2348012345678',
                        },
                        verificationDate: {
                            type: 'string',
                            format: 'date-time',
                            nullable: true,
                        },
                        status: {
                            type: 'string',
                            enum: ['active', 'suspended', 'deleted'],
                            example: 'active',
                        },
                    },
                },
                VerificationMethod: {
                    type: 'object',
                    properties: {
                        methodType: {
                            type: 'string',
                            enum: ['portal', 'email', 'registration', 'microsoft', 'whatsapp'],
                            example: 'email',
                        },
                        isAvailable: {
                            type: 'boolean',
                            example: true,
                        },
                        priority: {
                            type: 'integer',
                            example: 1,
                        },
                        reason: {
                            type: 'string',
                            nullable: true,
                        },
                    },
                },
                MicrosoftRequestError: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['success', 'error'],
                    properties: {
                        success: { type: 'boolean', enum: [false] },
                        error: {
                            type: 'object',
                            additionalProperties: false,
                            required: ['code', 'statusCode'],
                            properties: {
                                code: { type: 'string', enum: ['BAD_REQUEST', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'INTERNAL_SERVER_ERROR', 'MICROSOFT_REQUEST_REJECTED', 'reauthentication_required', 'consent_notice_changed'] },
                                statusCode: { type: 'integer', minimum: 400, maximum: 599 },
                            },
                        },
                    },
                },
                MicrosoftConsentSnapshot: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['universityId', 'providerPolicyVersion', 'noticeVersion', 'mode', 'scopes'],
                    properties: {
                        universityId: { type: 'string', format: 'uuid' },
                        providerPolicyVersion: { type: 'integer', minimum: 1 },
                        noticeVersion: { type: 'string' },
                        mode: { type: 'string', enum: ['identity_only', 'graph_enrollment'] },
                        scopes: { type: 'array', items: { type: 'string' } },
                    },
                },
                MicrosoftStartResponse: {
                    type: 'object', additionalProperties: false, required: ['success', 'data'],
                    properties: {
                        success: { type: 'boolean', enum: [true] },
                        data: {
                            type: 'object', additionalProperties: false,
                            required: ['attemptId', 'authorizationUrl', 'finishSecret', 'expiresAt', 'serverNow'],
                            properties: {
                                attemptId: { type: 'string', format: 'uuid' },
                                authorizationUrl: { type: 'string', format: 'uri' },
                                finishSecret: { type: 'string' },
                                expiresAt: { type: 'string', format: 'date-time' },
                                serverNow: { type: 'string', format: 'date-time' },
                            },
                        },
                    },
                },
                MicrosoftFinishResponse: {
                    type: 'object', additionalProperties: false, required: ['success', 'data'],
                    properties: {
                        success: { type: 'boolean', enum: [true] },
                        data: {
                            type: 'object', additionalProperties: false, required: ['accountLinked', 'enrollment'],
                            properties: {
                                accountLinked: { type: 'boolean', enum: [true] },
                                enrollment: { type: 'string', enum: ['not_checked', 'eligible', 'unconfirmed', 'denied'] },
                            },
                        },
                    },
                },
                MicrosoftNoticeResponse: {
                    type: 'object', additionalProperties: false, required: ['success', 'data'],
                    properties: {
                        success: { type: 'boolean', enum: [true] },
                        data: {
                            type: 'object', additionalProperties: false, required: ['snapshot', 'copy'],
                            properties: {
                                snapshot: { $ref: '#/components/schemas/MicrosoftConsentSnapshot' },
                                copy: {
                                    type: 'object', additionalProperties: false, required: ['text'],
                                    properties: { text: { type: 'string' } },
                                },
                            },
                        },
                    },
                },
                MicrosoftConsentHistoryResponse: {
                    type: 'object', additionalProperties: false, required: ['success', 'data'],
                    properties: {
                        success: { type: 'boolean', enum: [true] },
                        data: {
                            type: 'object', additionalProperties: false, required: ['items', 'nextCursor'],
                            properties: {
                                items: {
                                    type: 'array', items: {
                                        type: 'object', additionalProperties: false,
                                        required: ['id', 'snapshot', 'acceptedAt', 'withdrawnAt'],
                                        properties: {
                                            id: { type: 'string', format: 'uuid' },
                                            snapshot: { $ref: '#/components/schemas/MicrosoftConsentSnapshot' },
                                            acceptedAt: { type: 'string', format: 'date-time' },
                                            withdrawnAt: { type: 'string', format: 'date-time', nullable: true },
                                        },
                                    },
                                },
                                nextCursor: { type: 'string', format: 'uuid', nullable: true },
                            },
                        },
                    },
                },
                MicrosoftConsentAcceptanceResponse: {
                    type: 'object', additionalProperties: false, required: ['success', 'data'],
                    properties: {
                        success: { type: 'boolean', enum: [true] },
                        data: {
                            type: 'object', additionalProperties: false, required: ['providerConsentId'],
                            properties: { providerConsentId: { type: 'string', format: 'uuid' } },
                        },
                    },
                },
                MicrosoftConsentWithdrawalResponse: {
                    type: 'object', additionalProperties: false, required: ['success', 'data'],
                    properties: {
                        success: { type: 'boolean', enum: [true] },
                        data: {
                            type: 'object', additionalProperties: false, required: ['providerConsentId', 'withdrawn'],
                            properties: {
                                providerConsentId: { type: 'string', format: 'uuid' },
                                withdrawn: { type: 'boolean', enum: [true] },
                            },
                        },
                    },
                },
                MicrosoftIdentityHistoryResponse: {
                    type: 'object', additionalProperties: false, required: ['success', 'data'],
                    properties: {
                        success: { type: 'boolean', enum: [true] },
                        data: {
                            type: 'object', additionalProperties: false, required: ['items', 'nextCursor'],
                            properties: {
                                items: {
                                    type: 'array', items: {
                                        type: 'object', additionalProperties: false,
                                        required: ['id', 'universityId', 'universityName', 'linkedAt', 'revokedAt', 'status'],
                                        properties: {
                                            id: { type: 'string', format: 'uuid' },
                                            universityId: { type: 'string', format: 'uuid' },
                                            universityName: { type: 'string' },
                                            linkedAt: { type: 'string', format: 'date-time' },
                                            revokedAt: { type: 'string', format: 'date-time', nullable: true },
                                            status: { type: 'string', enum: ['connected', 'revoked'] },
                                        },
                                    },
                                },
                                nextCursor: { type: 'string', format: 'uuid', nullable: true },
                            },
                        },
                    },
                },
                MicrosoftIdentityUnlinkResponse: {
                    type: 'object', additionalProperties: false, required: ['success', 'data'],
                    properties: {
                        success: { type: 'boolean', enum: [true] },
                        data: {
                            type: 'object', additionalProperties: false,
                            required: ['identityId', 'unlinked', 'recovery'],
                            properties: {
                                identityId: { type: 'string', format: 'uuid' },
                                unlinked: { type: 'boolean', enum: [true] },
                                recovery: { type: 'string', enum: ['support_required'] },
                            },
                        },
                    },
                },
            },
            responses: {
                BadRequest: {
                    description: 'Bad request',
                    content: {
                        'application/json': {
                            schema: {
                                $ref: '#/components/schemas/Error',
                            },
                        },
                    },
                },
                Unauthorized: {
                    description: 'Unauthorized',
                    content: {
                        'application/json': {
                            schema: {
                                $ref: '#/components/schemas/Error',
                            },
                        },
                    },
                },
                MicrosoftRequestError: {
                    description: 'Microsoft request rejected without provider or operation detail',
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/MicrosoftRequestError' },
                        },
                    },
                },
            },
        },
        security: [
            {
                bearerAuth: [],
            },
        ],
    },
    apis: [
        './src/routes/*.ts',
        './src/routes/*.swagger.ts',
        './src/controllers/*.ts',
    ],
};

function compiledSwaggerSpec(): ReturnType<typeof swaggerJsdoc> {
    const renderedPath = fileURLToPath(new URL('./openapi.json', import.meta.url));
    let raw: string;
    try {
        raw = readFileSync(renderedPath, 'utf8');
    } catch {
        throw new Error('Compiled OpenAPI artifact is missing: dist/config/openapi.json. Run npm run build:artifact.');
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || !('paths' in parsed) || !parsed.paths || typeof parsed.paths !== 'object' || Object.keys(parsed.paths).length === 0) {
            throw new Error('Compiled OpenAPI artifact has no paths.');
        }
        const spec = parsed as { servers?: Array<{ url?: unknown; description?: unknown }> };
        const developmentServer = spec.servers?.find((server) => server.description === 'Development server');
        if (!developmentServer || typeof developmentServer.url !== 'string') throw new Error('Compiled OpenAPI artifact is missing its development server contract.');
        // The artifact owns route/component documentation; the local listener
        // port remains an explicitly documented runtime-only server value.
        developmentServer.url = `http://localhost:${config.port}`;
        return parsed as ReturnType<typeof swaggerJsdoc>;
    } catch (error) {
        if (error instanceof Error && error.message === 'Compiled OpenAPI artifact has no paths.') throw error;
        throw new Error('Compiled OpenAPI artifact is invalid JSON.');
    }
}

// TSX preserves the source .ts URL while tsc emits this module as .js. This
// deterministic layout check keeps source development live and makes a dist
// runtime fail closed instead of scanning absent source comments.
const isCompiledModule = fileURLToPath(import.meta.url).endsWith('.js');
export const swaggerSpec = isCompiledModule ? compiledSwaggerSpec() : swaggerJsdoc(options);
