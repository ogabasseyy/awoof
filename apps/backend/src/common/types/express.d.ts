/**
 * Express Type Extensions
 * 
 * Extends Express Request type to include custom properties
 */

import type { Request } from 'express';

declare global {
    namespace Express {
        interface Request {
            // User information from JWT token
            user?: {
                id: string;
                userId: string;
                email: string;
                role: 'student' | 'vendor' | 'admin';
                sid?: string;
                iat?: number;
                exp?: number;
            };

            // API key information (for Verify API)
            apiKey?: {
                id: string;
                vendorId?: string;
                rateLimit: number;
            };

            // Request ID for tracing
            requestId?: string;
        }
    }
}

export { };
