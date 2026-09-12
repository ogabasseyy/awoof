import { Router, type NextFunction, type Request, type Response } from 'express';
import { BadRequestError, ServiceUnavailableError } from '../common/errors/AppError.js';
import { asyncHandler } from '../common/middleware/errorHandler.js';
import { config } from '../config/env.js';
import { getPool } from '../config/database.js';
import { requireMicrosoftSession } from '../middleware/microsoft-session.js';
import { MicrosoftFlowService } from '../services/verification/microsoft-flow.service.js';
import { MicrosoftOidcService, type MicrosoftOidc } from '../services/verification/microsoft-oidc.service.js';
import { forApprovedMicrosoftTenant } from '../services/verification/microsoft-oidc.config.js';

type Flow = Pick<MicrosoftFlowService, 'start' | 'callback' | 'finish'> & Partial<Pick<MicrosoftFlowService, 'callbackCookieNameForState'>>;
type FlowFactory = () => Flow;

function exactJson(req: Request, _res: Response, next: NextFunction): void {
    if (!req.is('application/json')) return next(new BadRequestError('Microsoft verification requires JSON'));
    next();
}

function exactOrigin(req: Request, _res: Response, next: NextFunction): void {
    if (req.header('origin') !== config.microsoftVerification.frontendOrigin) {
        return next(new BadRequestError('Microsoft verification origin is invalid'));
    }
    next();
}

function bodyIds(req: Request, names: readonly string[]): Record<string, string> {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== names.length
        || names.some((name) => typeof body[name] !== 'string' || body[name].length === 0 || body[name].length > 200)) {
        throw new BadRequestError('Microsoft verification request is invalid');
    }
    return body as Record<string, string>;
}

function responseHeaders(res: Response): void {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
}

function defaultFlow(): Flow {
    const oidcConfig = config.microsoftOidc;
    const key = config.microsoftVerification.attemptEncryptionKey;
    if (!oidcConfig.enabled || !key) throw new ServiceUnavailableError('Microsoft verification is unavailable');
    // The OIDC client is configured from server-held approved configuration.
    // The lifecycle service supplies the locked policy tenant; the reviewed
    // transport rejects any tenant other than this configured adapter tenant.
    const oidc: { forTenant(tenantId: string): MicrosoftOidc } = {
        forTenant: (tenantId) => MicrosoftOidcService.forConfiguration(forApprovedMicrosoftTenant(oidcConfig, tenantId)),
    };
    return new MicrosoftFlowService({
        pool: getPool(), oidc, verifierEncryptionKey: key,
        callbackUrl: oidcConfig.callbackUrl, completionUrl: oidcConfig.frontendCompletionUrl,
        isEnabled: () => config.microsoftOidc.enabled,
    });
}

export function createMicrosoftVerificationRouter(factory: FlowFactory = defaultFlow): Router {
    const router = Router();

    router.post('/start', exactOrigin, exactJson, requireMicrosoftSession('issuance'), asyncHandler(async (req, res) => {
        const body = bodyIds(req, ['processingGrantId', 'providerConsentId']);
        const result = await factory().start({ userId: req.user!.id, serverSessionId: req.user!.sid!, processingGrantId: body.processingGrantId!, providerConsentId: body.providerConsentId! });
        responseHeaders(res);
        res.cookie(result.callbackCookie.name, result.callbackCookie.value, {
            maxAge: result.callbackCookie.maxAgeSeconds * 1000, path: result.callbackCookie.path,
            httpOnly: true, secure: true, sameSite: result.callbackCookie.sameSite,
        });
        res.status(201).json({ success: true, data: result.publicResult });
    }));

    router.get('/callback', asyncHandler(async (req, res) => {
        responseHeaders(res);
        // State is used inside the service to resolve the durable attempt
        // before selecting this server-generated cookie name.
        const browserCookies = String(req.headers.cookie ?? '').split(';').flatMap((entry) => {
            const separator = entry.indexOf('=');
            if (separator <= 0) return [];
            return [{ name: entry.slice(0, separator).trim(), value: entry.slice(separator + 1) }];
        });
        const callbackUrl = new URL(`${req.protocol}://${req.get('host')}${req.originalUrl}`);
        // The service compares this to the server fixed callback URL. The raw
        // query never reaches a response, log line, or redirect location.
        const flow = factory();
        const resolvedCookieName = await flow.callbackCookieNameForState?.(callbackUrl);
        try {
            const result = await flow.callback({ callbackUrl, browserCookies });
            res.clearCookie(`awoof_ms_${result.attemptId}`, { path: '/api/verification/microsoft/callback', httpOnly: true, secure: true, sameSite: 'lax' });
            res.redirect(303, result.completionUrl.href);
        } catch (error) {
            if (resolvedCookieName) res.clearCookie(resolvedCookieName, { path: '/api/verification/microsoft/callback', httpOnly: true, secure: true, sameSite: 'lax' });
            throw error;
        }
    }));

    router.post('/finish', exactOrigin, exactJson, requireMicrosoftSession('issuance'), asyncHandler(async (req, res) => {
        const body = bodyIds(req, ['attemptId', 'finishSecret']);
        const result = await factory().finish({ userId: req.user!.id, serverSessionId: req.user!.sid!, attemptId: body.attemptId!, finishSecret: body.finishSecret! });
        responseHeaders(res);
        res.json({ success: true, data: result });
    }));

    return router;
}

export default createMicrosoftVerificationRouter;
