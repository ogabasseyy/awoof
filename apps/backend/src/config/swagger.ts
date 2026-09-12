/**
 * Swagger/OpenAPI Configuration
 * 
 * API documentation setup for product owner visibility
 */

import swaggerJsdoc from 'swagger-jsdoc';
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

export const swaggerSpec = swaggerJsdoc(options);
