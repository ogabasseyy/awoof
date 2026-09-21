import { Router, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import type { Pool } from 'pg';
import { AppError, BadRequestError, NotFoundError, ServiceUnavailableError } from '../common/errors/AppError.js';
import { asyncHandler } from '../common/middleware/errorHandler.js';
import { config } from '../config/env.js';
import { getPool } from '../config/database.js';
import { getRedisClient } from '../config/redis.js';
import { STUDENT_SSO_COMPLETION_PATH, enabledStudentSsoProviders } from '../services/auth/student-oidc.config.js';
import { checkSsoStartQuota, createRedisQuotaStore } from '../services/auth/student-login-options.service.js';
import {
    STUDENT_SSO_COOKIE_PATH,
    StudentSsoFlowService,
    parseStudentSsoProvider,
    studentSsoCookieName,
} from '../services/auth/student-sso-flow.service.js';
import { StudentGoogleOidc } from '../services/auth/student-google-oidc.js';
import { StudentMicrosoftOidc } from '../services/auth/student-microsoft-oidc.js';
import type { ApprovedLoginPolicy, StudentSsoOidcResolver } from '../services/auth/student-sso-flow.service.js';
import type { LoginProvider } from '../services/auth/student-sso.types.js';
import { hashMicrosoftAttemptSecret } from '../services/verification/microsoft-attempt-crypto.js';

export type StudentSsoFlow = Pick<StudentSsoFlowService, 'start' | 'callback' | 'finish' | 'callbackCookieNameForState'>;
type FlowFactory = () => StudentSsoFlow;
export type StudentSsoRouterOptions = {
    isIssuanceEnabled?: () => boolean;
    enabledProviders?: () => LoginProvider[];
    completionOrigin?: string;
    checkStartQuota?: (clientIp: string, mailbox: string) => Promise<void>;
    pool?: Pick<Pool, 'query'>;
    callbackLimiterMax?: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isStudentSsoRoute(path: string): boolean {
    const normalizedPath = path.toLowerCase();
    return normalizedPath === '/api/auth/student/sso' || normalizedPath.startsWith('/api/auth/student/sso/');
}

/** The provider-driven SSO return. It must stay reachable under load. */
export function isStudentSsoCallbackPath(path: string): boolean {
    const normalizedPath = path.toLowerCase();
    return normalizedPath === '/api/auth/student/sso/google/callback'
        || normalizedPath === '/api/auth/student/sso/microsoft/callback';
}

function responseHeaders(res: Response): void {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
}

function clearSsoCookie(res: Response, name: string): void {
    res.clearCookie(name, { path: STUDENT_SSO_COOKIE_PATH, httpOnly: true, secure: true, sameSite: 'lax' });
}

function parseBrowserCookies(req: Request): { name: string; value: string }[] {
    return String(req.headers.cookie ?? '').split(';').flatMap((entry) => {
        const separator = entry.indexOf('=');
        if (separator <= 0) return [];
        return [{ name: entry.slice(0, separator).trim(), value: entry.slice(separator + 1) }];
    });
}

function startBody(req: Request): { email: unknown; rememberMe?: unknown; returnPath?: unknown } {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestError('Student SSO start request is invalid');
    const keys = Object.keys(body);
    if (!('email' in body) || keys.some((key) => key !== 'email' && key !== 'rememberMe' && key !== 'returnPath')) {
        throw new BadRequestError('Student SSO start request is invalid');
    }
    const value = body as Record<string, unknown>;
    if (typeof value.email !== 'string' || ('rememberMe' in value && typeof value.rememberMe !== 'boolean')
        || ('returnPath' in value && typeof value.returnPath !== 'string')) {
        throw new BadRequestError('Student SSO start request is invalid');
    }
    return { email: value.email, ...(value.rememberMe === undefined ? {} : { rememberMe: value.rememberMe }), ...(value.returnPath === undefined ? {} : { returnPath: value.returnPath }) };
}

function finishBody(req: Request): { attemptId: string; finishSecret: string } {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestError('Student SSO finish request is invalid');
    const keys = Object.keys(body);
    if (keys.length !== 2 || !keys.includes('attemptId') || !keys.includes('finishSecret')) {
        throw new BadRequestError('Student SSO finish request is invalid');
    }
    const value = body as { attemptId: unknown; finishSecret: unknown };
    if (typeof value.attemptId !== 'string' || !UUID.test(value.attemptId)
        || typeof value.finishSecret !== 'string' || value.finishSecret.length === 0 || value.finishSecret.length > 1024) {
        throw new BadRequestError('Student SSO finish request is invalid');
    }
    return { attemptId: value.attemptId, finishSecret: value.finishSecret };
}

// The callback skips the shared API quota in the middleware stack so a
// provider return always reaches its bounded redirect. This dedicated
// limiter (one attempt lifetime window) keeps replayed states from
// converting that reachability into unbounded claim transactions.
// Authenticated completions (3xx) never consume the quota; outage redirects
// are unauthenticated and stay counted.
export function isQuotaExcusedCallback(_req: Request, res: Response): boolean {
    return res.statusCode < 400 && (res.locals as { outageRedirect?: boolean }).outageRedirect !== true;
}

function studentSsoCallbackLimiter(max: number) {
    return rateLimit({
        windowMs: 10 * 60 * 1000,
        max,
        standardHeaders: true,
        legacyHeaders: false,
        skipSuccessfulRequests: true,
        requestWasSuccessful: isQuotaExcusedCallback,
    });
}

/**
 * Completion redirect for an in-flight browser return that arrives while new
 * issuance is unavailable. Resolving the attempt by its state hash needs no
 * decryption, so the browser still lands on the bounded completion page.
 * Only the cookie bound to the resolved attempt is cleared.
 */
export async function ssoUnavailableCompletion(
    pool: Pick<Pool, 'query'>,
    completionUrl: URL,
    provider: LoginProvider,
    state: string | null,
): Promise<{ location: string; clearCookies: string[] }> {
    let attemptId: string | null = null;
    if (state) {
        const row = await pool.query<{ id: string }>(
            'SELECT id FROM student_auth_attempts WHERE state_hash = $1 AND provider = $2',
            [hashMicrosoftAttemptSecret(state), provider],
        );
        attemptId = row.rows[0]?.id ?? null;
    }
    const url = new URL(completionUrl.href);
    if (attemptId) {
        url.searchParams.set('attempt', attemptId);
        url.searchParams.set('outcome', 'connection_not_completed');
    }
    return { location: url.href, clearCookies: attemptId === null ? [] : [studentSsoCookieName(attemptId)] };
}

function defaultOidc(): StudentSsoOidcResolver {
    return {
        forPolicy: (policy: ApprovedLoginPolicy) => policy.provider === 'google'
            ? StudentGoogleOidc.forApprovedDomain(config.studentSso.google, policy.realm)
            : StudentMicrosoftOidc.forApprovedTenant(config.studentSso.microsoft, policy.realm),
    };
}

function defaultFlow(): StudentSsoFlow {
    const sso = config.studentSso;
    if ((!sso.google.enabled && !sso.microsoft.enabled) || !sso.completionUrl || !sso.attemptKey) {
        throw new ServiceUnavailableError('Student SSO is unavailable');
    }
    const googleCallback = sso.google.enabled ? sso.google.callbackUrl : new URL('https://localhost.invalid/api/auth/student/sso/google/callback');
    const microsoftCallback = sso.microsoft.enabled ? sso.microsoft.callbackUrl : new URL('https://localhost.invalid/api/auth/student/sso/microsoft/callback');
    return new StudentSsoFlowService({
        pool: getPool(),
        oidc: defaultOidc(),
        attemptKey: sso.attemptKey,
        callbackUrls: { google: googleCallback, microsoft: microsoftCallback },
        completionUrl: sso.completionUrl,
        isEnabled: () => config.studentSso.google.enabled || config.studentSso.microsoft.enabled,
    });
}

export function createStudentSsoRouter(factory: FlowFactory = defaultFlow, options: StudentSsoRouterOptions = {}): Router {
    const router = Router();
    const issuanceEnabled = options.isIssuanceEnabled
        ?? (() => config.studentSso.google.enabled || config.studentSso.microsoft.enabled);
    const providersEnabled = options.enabledProviders ?? (() => enabledStudentSsoProviders(config.studentSso));
    const completionOrigin = options.completionOrigin ?? config.studentSso.completionUrl?.origin;
    // Pools open per request only; mounting the router never connects.
    const poolForRequest = (): Pick<Pool, 'query'> => options.pool ?? getPool();
    const checkStartQuota = options.checkStartQuota ?? (async (clientIp: string, mailbox: string) => {
        const attemptKey = config.studentSso.attemptKey;
        if (!attemptKey) throw new ServiceUnavailableError('Student SSO is unavailable');
        await checkSsoStartQuota(createRedisQuotaStore(getRedisClient()), clientIp, mailbox, attemptKey);
    });
    const callbackLimiter = studentSsoCallbackLimiter(options.callbackLimiterMax ?? 60);

    const assertIssuanceEnabled = (): void => {
        if (!issuanceEnabled() || !completionOrigin) throw new ServiceUnavailableError('Student SSO is unavailable');
    };

    const requireIssuance = (_req: Request, _res: Response, next: NextFunction): void => {
        try {
            assertIssuanceEnabled();
        } catch (error) {
            next(error);
            return;
        }
        next();
    };

    const exactJson = (req: Request, _res: Response, next: NextFunction): void => {
        if (!req.is('application/json')) return next(new BadRequestError('Student SSO requires JSON'));
        next();
    };

    // Session-mutating POSTs are never CSRF-exempt: exact configured Origin
    // plus JSON content type. Cross-origin same-site web/API requests use
    // credentials against the existing exact-origin allowlist, never a
    // wildcard credentialed CORS policy.
    const exactOrigin = (req: Request, _res: Response, next: NextFunction): void => {
        if (req.header('origin') !== completionOrigin) {
            return next(new BadRequestError('Student SSO origin is invalid'));
        }
        next();
    };

    router.post('/:provider/start', requireIssuance, exactOrigin, exactJson, asyncHandler(async (req, res) => {
        const provider = parseStudentSsoProvider(req.params.provider);
        if (!providersEnabled().includes(provider)) throw new NotFoundError('Student SSO is not available');
        const body = startBody(req);
        const clientIp = typeof req.ip === 'string' && req.ip !== '' ? req.ip : 'unknown';
        await checkStartQuota(clientIp, String(body.email));
        const result = await factory().start({ provider, email: body.email, ...(body.rememberMe === undefined ? {} : { rememberMe: body.rememberMe }), ...(body.returnPath === undefined ? {} : { returnPath: body.returnPath }) });
        responseHeaders(res);
        res.cookie(result.callbackCookie.name, result.callbackCookie.value, {
            maxAge: result.callbackCookie.maxAgeSeconds * 1000,
            path: result.callbackCookie.path,
            httpOnly: true,
            secure: true,
            sameSite: result.callbackCookie.sameSite,
        });
        res.status(201).json({ success: true, data: result.publicResult });
    }));

    router.get('/:provider/callback', callbackLimiter, asyncHandler(async (req, res) => {
        responseHeaders(res);
        const provider = parseStudentSsoProvider(req.params.provider);
        const browserCookies = parseBrowserCookies(req);
        const callbackUrl = new URL(`${req.protocol}://${req.get('host')}${req.originalUrl}`);
        let flow: StudentSsoFlow;
        try {
            flow = factory();
        } catch (error) {
            if (!(error instanceof ServiceUnavailableError)) throw error;
            const completionUrl = config.studentSso.completionUrl
                ?? (completionOrigin ? new URL(STUDENT_SSO_COMPLETION_PATH, completionOrigin) : undefined);
            if (!completionUrl) throw error;
            const completed = await ssoUnavailableCompletion(poolForRequest(), completionUrl, provider, callbackUrl.searchParams.get('state'));
            res.locals.outageRedirect = true;
            for (const name of completed.clearCookies) clearSsoCookie(res, name);
            return res.redirect(303, completed.location);
        }
        const resolvedCookieName = await flow.callbackCookieNameForState(callbackUrl, provider);
        try {
            const result = await flow.callback({ provider, callbackUrl, browserCookies });
            // The binding is retained through callback success so finish and
            // an unlinked handoff still prove the same browser. Terminal
            // failure redirects clear it instead.
            if (result.outcome) {
                clearSsoCookie(res, studentSsoCookieName(result.attemptId));
            }
            res.redirect(303, result.completionUrl.href);
        } catch (error) {
            if (resolvedCookieName && error instanceof AppError && error.statusCode >= 400 && error.statusCode < 500) {
                clearSsoCookie(res, resolvedCookieName);
            }
            throw error;
        }
    }));

    router.post('/finish', requireIssuance, exactOrigin, exactJson, asyncHandler(async (req, res) => {
        const body = finishBody(req);
        const browserCookie = parseBrowserCookies(req).find((cookie) => cookie.name === studentSsoCookieName(body.attemptId))?.value;
        const result = await factory().finish({ attemptId: body.attemptId, finishSecret: body.finishSecret, browserCookie });
        responseHeaders(res);
        if (result.outcome === 'link_required') {
            // The cookie is retained through the handoff: linking still
            // proves the same browser, and B4 clears it on successful link.
            res.json({ success: true, data: result });
            return;
        }
        clearSsoCookie(res, studentSsoCookieName(body.attemptId));
        if (result.outcome === 'restart_required') {
            res.status(409).json({
                success: false,
                error: {
                    message: 'Student SSO attempt is no longer valid',
                    code: 'SSO_RESTART_REQUIRED',
                    statusCode: 409,
                    details: { outcome: 'restart_required' },
                },
            });
            return;
        }
        res.json({ success: true, data: result });
    }));

    return router;
}

export default createStudentSsoRouter();

/**
 * @swagger
 * /api/auth/student/sso/{provider}/start:
 *   post:
 *     summary: Begin a browser-bound student SSO login
 *     description: >
 *       Strict JSON. Returns an opaque attempt ID, authorization URL, and
 *       bounded finish secret, and sets a per-attempt Secure HttpOnly
 *       SameSite=Lax callback cookie. Never returns or logs provider tokens,
 *       codes, PKCE material, or client secrets. School-account assurance and
 *       enrollment eligibility stay separate; login never authorizes benefits.
 *     tags: [Authentication]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: provider
 *         required: true
 *         schema: { type: string, enum: [google, microsoft] }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [email]
 *             properties:
 *               email: { type: string, format: email, maxLength: 254 }
 *               rememberMe: { type: boolean }
 *               returnPath: { type: string, description: Same-origin relative path, never an auth route }
 *     responses:
 *       201:
 *         description: Pending SSO attempt with browser binding
 *         headers:
 *           Cache-Control: { schema: { type: string, example: no-store } }
 *           Set-Cookie: { schema: { type: string, example: awoof_sso_<attemptId>=<secret>; Path=/api/auth/student/sso; HttpOnly; Secure; SameSite=Lax } }
 *         content: { application/json: { schema: { $ref: '#/components/schemas/StudentSsoStartResponse' } } }
 *       400: { description: Invalid provider, body, origin, or content type }
 *       404: { description: SSO is not available for this email domain }
 *       429: { description: Too many SSO start requests }
 *       503: { description: Student SSO is unavailable }
 * /api/auth/student/sso/{provider}/callback:
 *   get:
 *     summary: Provider return for a student SSO login
 *     description: >
 *       Always redirects (303) to the fixed completion route with the attempt
 *       ID and, on terminal failure, a bounded outcome. No token or secret
 *       appears in the URL. Only the browser holding the per-attempt callback
 *       cookie can redeem the attempt, exactly once.
 *     tags: [Authentication]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: provider
 *         required: true
 *         schema: { type: string, enum: [google, microsoft] }
 *     responses:
 *       303: { description: Redirect to the fixed completion route }
 *       400: { description: Unknown provider }
 *       409: { description: Attempt is no longer valid }
 *       429: { description: Too many failed callback replays }
 * /api/auth/student/sso/finish:
 *   post:
 *     summary: Complete a ready student SSO login
 *     description: >
 *       Strict JSON with the tab secret plus the browser callback cookie.
 *       Issues at most one session per attempt for an already-linked identity,
 *       returns a short-lived link handoff for unlinked identities, or a
 *       controlled restart when the attempt is consumed, expired, or lost. An
 *       authenticated response carries studentAssurance only with
 *       assuranceStatus available; assurance null means unavailable, never
 *       verified. Never auto-links by email.
 *     tags: [Authentication]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [attemptId, finishSecret]
 *             properties:
 *               attemptId: { type: string, format: uuid }
 *               finishSecret: { type: string }
 *     responses:
 *       200:
 *         description: Authenticated session or link handoff
 *         headers:
 *           Cache-Control: { schema: { type: string, example: no-store } }
 *         content: { application/json: { schema: { $ref: '#/components/schemas/StudentSsoFinishResponse' } } }
 *       400: { description: Invalid body, origin, or content type }
 *       409: { description: Attempt is no longer valid, or restart required (SSO_RESTART_REQUIRED) }
 *       503: { description: Student SSO is unavailable }
 */
