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
                PasswordlessSignupHandoffRequest: { type: 'object', additionalProperties: false, required: ['handoffId', 'handoffSecret'], properties: { handoffId: { type: 'string', format: 'uuid' }, handoffSecret: { type: 'string', minLength: 1, maxLength: 1024 } } },
                PasswordlessSignupVerifyRequest: { type: 'object', additionalProperties: false, required: ['handoffId', 'handoffSecret', 'challengeId', 'code'], properties: { handoffId: { type: 'string', format: 'uuid' }, handoffSecret: { type: 'string', minLength: 1, maxLength: 1024 }, challengeId: { type: 'string', format: 'uuid' }, code: { type: 'string', minLength: 6, maxLength: 6, pattern: '^\\d{6}$', description: 'Six-digit mailbox OTP; anything else is rejected.' } } },
                PasswordlessSignupCompleteRequest: { type: 'object', additionalProperties: false, required: ['handoffId', 'handoffSecret', 'fullName', 'ageAttested', 'termsAccepted', 'termsVersion', 'verificationConsent', 'noticeVersion'], properties: { handoffId: { type: 'string', format: 'uuid' }, handoffSecret: { type: 'string', minLength: 1, maxLength: 1024 }, fullName: { type: 'string', pattern: '^\\s*\\S[\\s\\S]{0,253}\\S\\s*$', description: 'Display name; 2-255 characters after trimming. Surrounding whitespace is accepted and trimmed by the endpoint, so raw length is unconstrained and the pattern measures the trimmed value.' }, ageAttested: { type: 'boolean', enum: [true] }, termsAccepted: { type: 'boolean', enum: [true] }, termsVersion: { type: 'string', minLength: 1 }, verificationConsent: { type: 'boolean', enum: [true] }, noticeVersion: { type: 'string', minLength: 1 } } },
                PasswordlessSignupContextResponse: { type: 'object', required: ['success', 'data'], properties: { success: { type: 'boolean', enum: [true] }, data: { type: 'object', required: ['email', 'universityId', 'termsVersion', 'noticeVersion', 'noticeText', 'expiresAt'], properties: { email: { type: 'string', format: 'email' }, universityId: { type: 'string', format: 'uuid' }, termsVersion: { type: 'string', minLength: 1 }, noticeVersion: { type: 'string', minLength: 1 }, noticeText: { type: 'string', minLength: 1 }, expiresAt: { type: 'string', format: 'date-time' } } } } },
                PasswordlessSignupCodeResponse: { type: 'object', required: ['success', 'data'], properties: { success: { type: 'boolean', enum: [true] }, data: { type: 'object', required: ['challengeId', 'expiresAt'], properties: { challengeId: { type: 'string', format: 'uuid' }, expiresAt: { type: 'string', format: 'date-time' } } } } },
                PasswordlessSignupVerifiedResponse: { type: 'object', required: ['success', 'data'], properties: { success: { type: 'boolean', enum: [true] }, data: { type: 'object', required: ['verified', 'expiresAt'], properties: { verified: { type: 'boolean', enum: [true] }, expiresAt: { type: 'string', format: 'date-time', description: 'Pending signup expiry; verification does not extend the handoff window.' } } } } },
                PasswordlessSignupAvailabilityResponse: { type: 'object', required: ['success', 'data'], properties: { success: { type: 'boolean', enum: [true] }, data: { type: 'object', required: ['available'], properties: { available: { type: 'boolean' } } } } },
                PasswordlessSignupCompleteResponse: { type: 'object', required: ['success', 'data'], properties: { success: { type: 'boolean', enum: [true] }, data: { type: 'object', required: ['user', 'tokens'], properties: { user: { type: 'object', required: ['id', 'email', 'role'], properties: { id: { type: 'string', format: 'uuid' }, email: { type: 'string', format: 'email' }, role: { type: 'string', enum: ['student'] } } }, tokens: { type: 'object', required: ['accessToken', 'refreshToken'], properties: { accessToken: { type: 'string', readOnly: true }, refreshToken: { type: 'string', readOnly: true } } } } } } },
                ReauthGrant: { type: 'object', additionalProperties: false, required: ['grantId', 'grantSecret'], properties: { grantId: { type: 'string', format: 'uuid' }, grantSecret: { type: 'string', minLength: 1, maxLength: 1024 } } },
                RecoveryCodeGenerateRequest: { type: 'object', additionalProperties: false, required: ['reauthGrant'], properties: { reauthGrant: { $ref: '#/components/schemas/ReauthGrant' }, oldCode: { type: 'string', minLength: 1, maxLength: 1024 } } },
                RecoveryCodeActivateRequest: { type: 'object', additionalProperties: false, required: ['reauthGrant', 'pendingCodeId', 'code'], properties: { reauthGrant: { $ref: '#/components/schemas/ReauthGrant' }, pendingCodeId: { type: 'string', format: 'uuid' }, code: { type: 'string', minLength: 1, maxLength: 1024 }, oldCode: { type: 'string', minLength: 1, maxLength: 1024 } } },
                RecoveryCodeRemoveRequest: { type: 'object', additionalProperties: false, required: ['reauthGrant', 'oldCode'], properties: { reauthGrant: { $ref: '#/components/schemas/ReauthGrant' }, oldCode: { type: 'string', minLength: 1, maxLength: 1024 } } },
                RecoveryCodeStatusResponse: { type: 'object', required: ['success', 'data'], properties: { success: { type: 'boolean', enum: [true] }, data: { type: 'object', required: ['status', 'generation', 'pendingCodeId', 'pendingExpiresAt', 'serverNow'], properties: { status: { type: 'string', enum: ['unconfigured', 'pending', 'active'] }, generation: { type: 'integer', nullable: true }, pendingCodeId: { type: 'string', format: 'uuid', nullable: true }, pendingExpiresAt: { type: 'string', format: 'date-time', nullable: true, description: 'Pending-code activation deadline; null unless a live candidate exists.' }, serverNow: { type: 'string', format: 'date-time', description: 'Server clock at response time; clients correct countdowns against it.' } } } } },
                RecoveryCodeGeneratedResponse: { type: 'object', required: ['success', 'data'], properties: { success: { type: 'boolean', enum: [true] }, data: { type: 'object', required: ['pendingCodeId', 'code', 'generation', 'expiresAt', 'serverNow'], properties: { pendingCodeId: { type: 'string', format: 'uuid' }, code: { type: 'string', readOnly: true }, generation: { type: 'integer', minimum: 1, description: 'Pending-code generation; ambiguous activations require the reloaded active generation to match.' }, expiresAt: { type: 'string', format: 'date-time', description: 'Pending-code activation deadline.' }, serverNow: { type: 'string', format: 'date-time', description: 'Server clock at response time; clients correct countdowns against it.' } } } } },
                RecoveryCodeActivatedResponse: { type: 'object', required: ['success', 'data'], properties: { success: { type: 'boolean', enum: [true] }, data: { type: 'object', required: ['active'], properties: { active: { type: 'boolean', enum: [true] } } } } },
                AccountRecoveryStartRequest: { type: 'object', additionalProperties: false, required: ['email', 'purpose'], properties: { email: { type: 'string', format: 'email', minLength: 1, maxLength: 255 }, purpose: { type: 'string', enum: ['lost_access', 'compromise'] }, idempotencyKey: { type: 'string', minLength: 1, maxLength: 128, description: 'Optional client retry binding. A cooldown retry only replaces the live attempt when it presents the original start key; without it the retry takes the frozen-expiry path and the live attempt is untouched.' } } },
                AccountRecoveryStartResponse: { type: 'object', required: ['success', 'data'], properties: { success: { type: 'boolean', enum: [true] }, data: { type: 'object', required: ['attemptId', 'secret', 'expiresAt', 'otpExpiresAt', 'serverNow'], properties: { attemptId: { type: 'string', format: 'uuid' }, secret: { type: 'string', readOnly: true }, expiresAt: { type: 'string', format: 'date-time', description: 'Recovery-handle expiry; identical for decoy and committed handles.' }, otpExpiresAt: { type: 'string', format: 'date-time', description: 'Mailbox-OTP deadline for the pre-verification view; identical for decoy and committed handles.' }, serverNow: { type: 'string', format: 'date-time', description: 'Server clock at response time; identical shape for decoy and committed handles.' } } } } },
                AccountRecoveryVerifyRequest: { type: 'object', additionalProperties: false, required: ['attemptId', 'secret', 'code', 'otp'], properties: { attemptId: { type: 'string', format: 'uuid' }, secret: { type: 'string', minLength: 1, maxLength: 1024 }, code: { type: 'string', minLength: 1, maxLength: 1024 }, otp: { type: 'string', minLength: 6, maxLength: 6, pattern: '^\\d{6}$', description: 'Six-digit mailbox OTP; anything else is rejected.' } } },
                AccountRecoveryVerifiedResponse: { type: 'object', required: ['success', 'data'], properties: { success: { type: 'boolean', enum: [true] }, data: { type: 'object', required: ['expiresAt', 'serverNow'], properties: { expiresAt: { type: 'string', format: 'date-time', description: 'Completion deadline disclosed only after both recovery proofs succeed.' }, serverNow: { type: 'string', format: 'date-time', description: 'Server clock at successful verification.' } } } } },
                AccountRecoveryCompleteRequest: { type: 'object', additionalProperties: false, required: ['attemptId', 'secret', 'password'], properties: { attemptId: { type: 'string', format: 'uuid' }, secret: { type: 'string', minLength: 1, maxLength: 1024 }, password: { type: 'string', minLength: 8, maxLength: 72, writeOnly: true, pattern: '^(?=.*[A-Z])(?=.*[a-z])(?=.*[0-9])(?=.*[!@#$%^&*(),.?":{}|<>\\[\\]\\-_=+~`]).{8,}$', description: 'At least 8 characters with an uppercase letter, a lowercase letter, a number, and a special character. No more than 72 bytes of UTF-8: bcrypt incorporates only the first 72 bytes, so longer values are rejected even when they satisfy the complexity pattern.' } } },
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
                            deprecated: true,
                            description: 'Legacy compatibility flag. It never authorizes student benefits; use studentAssurance instead.',
                        },
                        studentAssurance: {
                            allOf: [
                                { $ref: '#/components/schemas/StudentAssurance' },
                            ],
                            nullable: true,
                            description: 'Present for student accounts only. Null means the status read is temporarily unavailable; retry without assuming a positive state.',
                        },
                        recoveryReenrollmentRequired: {
                            type: 'boolean',
                            example: true,
                            description: 'Present and true for student accounts only while account recovery consumed the only active recovery code and no replacement has activated. Absent otherwise.',
                        },
                    },
                },
                StudentAssurance: {
                    type: 'object',
                    description: 'Independent school-account and current-enrollment status projected from current evidence. Only studentStatus verified authorizes student benefits.',
                    required: [
                        'schoolAccountStatus',
                        'schoolAccountMethod',
                        'schoolAccountValidUntil',
                        'studentStatus',
                        'enrollmentMethod',
                        'studentValidUntil',
                        'reason',
                    ],
                    properties: {
                        schoolAccountStatus: {
                            type: 'string',
                            enum: ['unverified', 'verified', 'expired'],
                            example: 'verified',
                        },
                        schoolAccountMethod: {
                            type: 'string',
                            enum: ['email_otp', 'google_workspace', 'microsoft_school'],
                            nullable: true,
                            example: 'email_otp',
                        },
                        schoolAccountValidUntil: {
                            type: 'string',
                            format: 'date-time',
                            nullable: true,
                            example: '2026-10-01T00:00:00.000Z',
                        },
                        studentStatus: {
                            type: 'string',
                            enum: ['pending', 'verified', 'expired', 'denied', 'revoked', 'inactive'],
                            example: 'pending',
                        },
                        enrollmentMethod: {
                            type: 'string',
                            enum: ['registration', 'microsoft_graph'],
                            nullable: true,
                            example: null,
                        },
                        studentValidUntil: {
                            type: 'string',
                            format: 'date-time',
                            nullable: true,
                            example: null,
                        },
                        reason: {
                            type: 'string',
                            enum: [
                                'awaiting_enrollment',
                                'evidence_expired',
                                'enrollment_denied',
                                'consent_withdrawn',
                                'identity_changed',
                                'policy_changed',
                                'inactive',
                                'provider_unavailable',
                            ],
                            nullable: true,
                            example: 'awaiting_enrollment',
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
                StudentSsoStartResponse: {
                    type: 'object',
                    required: ['success', 'data'],
                    properties: {
                        success: { type: 'boolean', example: true },
                        data: {
                            type: 'object',
                            required: ['attemptId', 'authorizationUrl', 'finishSecret', 'expiresAt', 'serverNow'],
                            properties: {
                                attemptId: { type: 'string', format: 'uuid' },
                                authorizationUrl: { type: 'string', format: 'uri' },
                                finishSecret: { type: 'string', description: 'Tab-held secret for finish; never placed in a URL.' },
                                expiresAt: { type: 'string', format: 'date-time' },
                                serverNow: { type: 'string', format: 'date-time' },
                            },
                        },
                    },
                },
                StudentSsoFinishResponse: {
                    type: 'object',
                    required: ['success', 'data'],
                    properties: {
                        success: { type: 'boolean', example: true },
                        data: {
                            type: 'object',
                            required: ['outcome'],
                            discriminator: { propertyName: 'outcome' },
                            description: 'Authenticated sessions carry tokens with studentAssurance (null only when assuranceStatus is unavailable); link_required carries a short-lived handoff instead.',
                            properties: {
                                outcome: { type: 'string', enum: ['authenticated', 'link_required'] },
                            },
                            oneOf: [
                                {
                                    type: 'object',
                                    required: ['outcome', 'user', 'tokens', 'studentAssurance', 'assuranceStatus'],
                                    properties: {
                                        outcome: { type: 'string', enum: ['authenticated'] },
                                        user: { $ref: '#/components/schemas/User' },
                                        tokens: { $ref: '#/components/schemas/Tokens' },
                                        studentAssurance: {
                                            allOf: [{ $ref: '#/components/schemas/StudentAssurance' }],
                                            nullable: true,
                                            description: 'Null is permitted only with assuranceStatus unavailable; never treat it as verified.',
                                        },
                                        assuranceStatus: { type: 'string', enum: ['available', 'unavailable'] },
                                    },
                                },
                                {
                                    type: 'object',
                                    required: ['outcome', 'handoffId', 'handoffSecret', 'expiresAt', 'provider'],
                                    properties: {
                                        outcome: { type: 'string', enum: ['link_required'] },
                                        handoffId: { type: 'string', format: 'uuid' },
                                        handoffSecret: { type: 'string', description: 'Tab-held handoff secret for explicit linking; never placed in a URL.' },
                                        expiresAt: { type: 'string', format: 'date-time' },
                                        provider: { type: 'string', enum: ['google', 'microsoft'], description: 'Provider that produced the unknown identity; gates the provider-specific signup offer.' },
                                    },
                                },
                            ],
                        },
                    },
                },
                StudentSsoReauthResponse: {
                    type: 'object',
                    required: ['success', 'data'],
                    properties: {
                        success: { type: 'boolean', example: true },
                        data: {
                            type: 'object',
                            required: ['grantId', 'grantSecret', 'expiresAt'],
                            properties: {
                                grantId: { type: 'string', format: 'uuid' },
                                grantSecret: { type: 'string', description: 'Single-use grant secret, bound to the current user and session for five minutes.' },
                                expiresAt: { type: 'string', format: 'date-time' },
                            },
                        },
                    },
                },
                StudentSsoReauthStartResponse: {
                    type: 'object',
                    required: ['success', 'data'],
                    properties: {
                        success: { type: 'boolean', example: true },
                        data: {
                            type: 'object',
                            required: ['attemptId', 'authorizationUrl'],
                            properties: {
                                attemptId: { type: 'string', format: 'uuid' },
                                authorizationUrl: { type: 'string', format: 'uri', description: 'Microsoft authorization URL for the fresh proof; the browser binding travels as a Secure HttpOnly cookie.' },
                            },
                        },
                    },
                },
                StudentSsoReauthFinishResponse: {
                    type: 'object',
                    required: ['success', 'data'],
                    properties: {
                        success: { type: 'boolean', example: true },
                        data: {
                            type: 'object',
                            required: ['grantId', 'grantSecret', 'expiresAt', 'purpose', 'pendingCodeId', 'targetIdentityId', 'activeCodeGeneration'],
                            properties: {
                                grantId: { type: 'string', format: 'uuid' },
                                grantSecret: { type: 'string', description: 'Single-use grant secret, bound to the current user and session for five minutes.' },
                                expiresAt: { type: 'string', format: 'date-time' },
                                purpose: { type: 'string', enum: ['link', 'unlink', 'recovery_code_generate', 'recovery_code_activate', 'recovery_code_remove'] },
                                pendingCodeId: { type: 'string', format: 'uuid', nullable: true, description: 'Pending code this grant is bound to, if any.' },
                                targetIdentityId: { type: 'string', format: 'uuid', nullable: true, description: 'Identity this grant is bound to, if any.' },
                                activeCodeGeneration: { type: 'integer', nullable: true, description: 'Active recovery-code generation pinned at proof time, if any.' },
                            },
                        },
                    },
                },
                StudentSsoLinkResponse: {
                    type: 'object',
                    required: ['success', 'data'],
                    properties: {
                        success: { type: 'boolean', example: true },
                        data: {
                            type: 'object',
                            required: ['outcome', 'identity', 'schoolAssertion', 'reactivated'],
                            properties: {
                                outcome: { type: 'string', enum: ['linked'] },
                                identity: {
                                    type: 'object',
                                    required: ['id', 'provider', 'universityName', 'linkedAt'],
                                    properties: {
                                        id: { type: 'string', format: 'uuid' },
                                        provider: { type: 'string', enum: ['google', 'microsoft'] },
                                        universityName: { type: 'string' },
                                        linkedAt: { type: 'string', format: 'date-time' },
                                        mailboxMasked: { type: 'string', description: 'Masked sign-in mailbox (first character plus domain) for telling same-university identities apart; absent when the provider supplied none.' },
                                    },
                                },
                                schoolAssertion: {
                                    type: 'string',
                                    enum: ['recorded', 'not_attested'],
                                    description: 'Whether membership evidence supported a school assertion. Linking never authorizes enrollment benefits.',
                                },
                                reactivated: { type: 'boolean', description: 'True when the original owner reactivated a revoked identity.' },
                            },
                        },
                    },
                },
                StudentSsoUnlinkResponse: {
                    type: 'object',
                    required: ['success', 'data'],
                    properties: {
                        success: { type: 'boolean', example: true },
                        data: {
                            type: 'object',
                            required: ['unlinked', 'sessionRevoked'],
                            properties: {
                                unlinked: { type: 'boolean', enum: [true] },
                                sessionRevoked: { type: 'boolean', description: 'True when the removed identity had issued the active session; the client must drop its local tokens.' },
                            },
                        },
                    },
                },
                StudentSsoIdentitiesResponse: {
                    type: 'object',
                    required: ['success', 'data'],
                    properties: {
                        success: { type: 'boolean', example: true },
                        data: {
                            type: 'object',
                            required: ['identities'],
                            properties: {
                                identities: {
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        required: ['id', 'provider', 'universityName', 'linkedAt'],
                                        properties: {
                                            id: { type: 'string', format: 'uuid' },
                                            provider: { type: 'string', enum: ['google', 'microsoft'] },
                                            universityName: { type: 'string' },
                                            linkedAt: { type: 'string', format: 'date-time' },
                                            mailboxMasked: { type: 'string', description: 'Masked sign-in mailbox (first character plus domain) for telling same-university identities apart; absent when the provider supplied none.' },
                                        },
                                    },
                                },
                            },
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
                SessionValidationUnavailable: {
                    description: 'Student session validation is temporarily unavailable',
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/Error' },
                        },
                    },
                },
                MerchantPaymentUnavailable: {
                    description: 'Merchant payment verification is temporarily unavailable',
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/Error' },
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
