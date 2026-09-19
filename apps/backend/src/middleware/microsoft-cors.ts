import type { NextFunction, Request, Response } from 'express';

export function isMicrosoftRoute(path: string): boolean {
    const normalizedPath = path.toLowerCase();
    return normalizedPath === '/api/verification/microsoft' || normalizedPath.startsWith('/api/verification/microsoft/');
}

export type MicrosoftCorsOptions = { frontendOrigin: string };

function appendVary(res: Response, value: string): void {
    const current = res.getHeader('Vary');
    const values = new Set(String(current ?? '').split(',').map((entry) => entry.trim()).filter(Boolean));
    values.add(value);
    res.setHeader('Vary', [...values].join(', '));
}

/** Exact-origin, credentialed CORS for the Microsoft namespace only. */
export function microsoftCors(options: MicrosoftCorsOptions) {
    return (req: Request, res: Response, next: NextFunction): void => {
        if (!isMicrosoftRoute(req.path)) return next();
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        appendVary(res, 'Origin');
        const origin = req.header('origin');
        if (origin === options.frontendOrigin) {
            res.setHeader('Access-Control-Allow-Origin', options.frontendOrigin);
            res.setHeader('Access-Control-Allow-Credentials', 'true');
            if (req.method === 'OPTIONS') {
                res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
                res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
                res.status(204).end();
                return;
            }
        } else if (req.method === 'OPTIONS') {
            res.status(403).json({ success: false, error: { code: 'MICROSOFT_ORIGIN_DENIED', statusCode: 403 } });
            return;
        }
        next();
    };
}
