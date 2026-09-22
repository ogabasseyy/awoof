import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../common/errors/AppError.js';
import { appLogger } from '../common/logger.js';

const safeErrorByStatus: Record<number, { message: string; code: string }> = {
    401: { message: 'Authentication required', code: 'UNAUTHORIZED' },
    403: { message: 'Current administrator authority required', code: 'FORBIDDEN' },
    404: { message: 'Verification diagnostic not found', code: 'NOT_FOUND' },
    422: { message: 'Invalid verification diagnostic identifier', code: 'VALIDATION_ERROR' },
    500: { message: 'Verification diagnostics are temporarily unavailable', code: 'INTERNAL_SERVER_ERROR' },
};

/**
 * Diagnostic errors can carry database/provider request detail. Keep this
 * boundary specific to the redacted administrator diagnostic surface rather
 * than changing the app-wide development error behavior.
 */
export function verificationDiagnosticsErrorHandler(error: unknown, _req: Request, res: Response, next: NextFunction): void {
    if (res.headersSent) return next(error);
    const statusCode = error instanceof ZodError
        ? 422
        : error instanceof AppError && safeErrorByStatus[error.statusCode]
          ? error.statusCode
          : 500;
    if (statusCode === 500) appLogger.error('Verification diagnostics request failed');
    const safe = safeErrorByStatus[statusCode]!;
    res.setHeader('Cache-Control', 'no-store');
    res.status(statusCode).json({
        success: false,
        error: { message: safe.message, code: safe.code, statusCode },
    });
}
