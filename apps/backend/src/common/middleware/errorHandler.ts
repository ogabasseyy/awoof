/**
 * Error Handler Middleware
 * 
 * Centralized error handling
 * Follows Single Responsibility Principle - only handles errors
 */

import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors/AppError.js';
import { config } from '../../config/env.js';
import { ZodError } from 'zod';
import { fromZodError, ValidationError } from 'zod-validation-error';

/**
 * Error response interface
 */
interface ErrorResponse {
    success: false;
    error: {
        message: string;
        code?: string;
        statusCode: number;
        details?: Record<string, any>;
        stack?: string;
    };
}

/**
 * Error handler middleware
 * Catches all errors and returns consistent error response
 */
export const errorHandler = (
    err: Error | AppError | ZodError,
    _req: Request,
    res: Response,
    _next: NextFunction
): void => {
    // Handle Multer errors (file type, size) - return 400 with clear message
    const multerMessage = err.message || '';
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'LIMIT_FILE_SIZE') {
        res.status(400).json({
            success: false,
            error: {
                message: 'File is too large. Maximum size is 2MB per file.',
                code: 'FILE_TOO_LARGE',
                statusCode: 400,
            },
        });
        return;
    }
    if (err instanceof Error && (multerMessage.includes('Invalid file type') || multerMessage.includes('only images'))) {
        res.status(400).json({
            success: false,
            error: {
                message: 'Invalid file type. Only images (JPEG, PNG, WebP) and PDFs are allowed.',
                code: 'INVALID_FILE_TYPE',
                statusCode: 400,
            },
        });
        return;
    }

    // Handle Zod validation errors
    if (err instanceof ZodError) {
        const validationError: ValidationError = fromZodError(err);

        const response: ErrorResponse = {
            success: false,
            error: {
                message: validationError.message,
                code: 'VALIDATION_ERROR',
                statusCode: 422,
                details: validationError.details,
            },
        };

        res.status(422).json(response);
        return;
    }

    // Handle application errors
    if (err instanceof AppError && err.isOperational) {
        const response: ErrorResponse = {
            success: false,
            error: {
                message: err.message,
                statusCode: err.statusCode,
                ...(err.code && { code: err.code }),
                ...(err.details && { details: err.details }),
                ...(config.isDevelopment && err.stack && { stack: err.stack }),
            },
        };

        res.status(err.statusCode).json(response);
        return;
    }

    // Handle unexpected errors
    console.error('❌ Unexpected error:', err);

    const response: ErrorResponse = {
        success: false,
        error: {
            message: config.isProduction
                ? 'An unexpected error occurred'
                : err.message,
            code: 'INTERNAL_SERVER_ERROR',
            statusCode: 500,
            ...(config.isDevelopment && {
                details: { originalError: err.message },
                stack: err.stack
            }),
        },
    };

    res.status(500).json(response);
};

/**
 * Async error wrapper
 * Catches errors from async route handlers
 */
export const asyncHandler = (
    fn: (req: Request, res: Response, next: NextFunction) => Promise<any>
) => {
    return (req: Request, res: Response, next: NextFunction) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
};

