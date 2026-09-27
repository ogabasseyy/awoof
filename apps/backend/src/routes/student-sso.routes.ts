import { Router, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import type { Pool } from 'pg';
import { AppError, BadRequestError, ConflictError, NotFoundError, ServiceUnavailableError, UnauthorizedError } from '../common/errors/AppError.js';
import { asyncHandler } from '../common/middleware/errorHandler.js';
import { authenticate, requireRole } from '../middleware/auth.middleware.js';
import { config } from '../config/env.js';
import { getPool } from '../config/database.js';
import { getRedisClient } from '../config/redis.js';
import { STUDENT_SSO_COMPLETION_PATH, enabledStudentSsoProviders } from '../services/auth/student-oidc.config.js';
import { checkSsoStartQuota, createRedisQuotaStore, normalizeStudentLoginEmail } from '../services/auth/student-login-options.service.js';
import {
    STUDENT_SSO_COOKIE_PATH,
    StudentSsoFlowService,
    parseStudentSsoProvider,
    studentSsoCookieName,
} from '../services/auth/student-sso-flow.service.js';
import { StudentGoogleOidc } from '../services/auth/student-google-oidc.js';
import { StudentMicrosoftOidc } from '../services/auth/student-microsoft-oidc.js';
import type { ApprovedLoginPolicy, StudentSsoOidcResolver } from '../services/auth/student-sso-flow.service.js';
import { StudentSsoLinkService } from '../services/auth/student-sso-link.service.js';
import { StudentSsoSignupService } from '../services/auth/student-sso-signup.service.js';
import { sendEmail, sendEmailVerificationOTP } from '../services/email/email.service.js';
import { StudentReauthService, studentReauthCookieName } from '../services/auth/student-reauth.service.js';
import { StudentRecoveryCodeService } from '../services/auth/student-recovery-code.service.js';
import { StudentAccountRecoveryService } from '../services/auth/student-account-recovery.service.js';
import type { LoginProvider } from '../services/auth/student-sso.types.js';
import { hashMicrosoftAttemptSecret } from '../services/verification/microsoft-attempt-crypto.js';

export type StudentSsoFlow = Pick<StudentSsoFlowService, 'start' | 'callback' | 'finish' | 'callbackCookieNameForState'>;
export type StudentSsoLink = Pick<StudentSsoLinkService, 'reauth' | 'link' | 'listIdentities' | 'unlink'>;
type FlowFactory = () => StudentSsoFlow;
type LinkFactory = () => StudentSsoLink;
type ReauthFactory = () => StudentReauthService;
type SignupFactory = () => StudentSsoSignupService;
type RecoveryCodeFactory = () => StudentRecoveryCodeService;
type AccountRecoveryFactory = () => StudentAccountRecoveryService;
export type StudentSsoRouterOptions = {
    isIssuanceEnabled?: () => boolean;
    enabledProviders?: () => LoginProvider[];
    completionOrigin?: string;
    checkStartQuota?: (clientIp: string, mailbox: string) => Promise<void>;
    pool?: Pick<Pool, 'query'>;
    callbackLimiterMax?: number;
    linkService?: LinkFactory;
    reauthService?: ReauthFactory;
    linkLimiterMax?: number;
    signupService?: SignupFactory;
    recoveryCodeService?: RecoveryCodeFactory;
    accountRecoveryService?: AccountRecoveryFactory;
    /** Passwordless new-account issuance is independently fail-closed. */
    isSignupEnabled?: () => boolean;
    /** Origin allowlist for provider-independent recovery actions. Defaults to the trusted frontend origin. */
    recoveryOrigin?: string;
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

function reauthBody(req: Request): { password: string; purpose: 'link' | 'unlink' | 'recovery_code_generate' | 'recovery_code_activate' | 'recovery_code_remove'; targetIdentityId?: string; pendingCodeId?: string } {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestError('Student SSO reauthentication request is invalid');
    const keys = Object.keys(body);
    if (!keys.includes('password') || !keys.includes('purpose') || keys.some((key) => key !== 'password' && key !== 'purpose' && key !== 'targetIdentityId' && key !== 'pendingCodeId')) {
        throw new BadRequestError('Student SSO reauthentication request is invalid');
    }
    const value = body as { password: unknown; purpose: unknown; targetIdentityId?: unknown; pendingCodeId?: unknown };
    if (typeof value.password !== 'string' || value.password.length === 0 || value.password.length > 1024
        || (value.purpose !== 'link' && value.purpose !== 'unlink' && value.purpose !== 'recovery_code_generate'
            && value.purpose !== 'recovery_code_activate' && value.purpose !== 'recovery_code_remove')
        || (value.targetIdentityId !== undefined && (typeof value.targetIdentityId !== 'string' || !UUID.test(value.targetIdentityId)))
        || (value.pendingCodeId !== undefined && (typeof value.pendingCodeId !== 'string' || !UUID.test(value.pendingCodeId)))) {
        throw new BadRequestError('Student SSO reauthentication request is invalid');
    }
    // Unlink grants are target-bound. Keeping the target optional in the
    // schema retains the established link request contract; an unbound
    // unlink grant simply cannot consume an identity-removal action.
    return { password: value.password, purpose: value.purpose,
        ...(value.targetIdentityId === undefined ? {} : { targetIdentityId: value.targetIdentityId }),
        ...(value.pendingCodeId === undefined ? {} : { pendingCodeId: value.pendingCodeId }) };
}

function grantBody(value: unknown): { grantId: string; grantSecret: string } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestError('Student SSO grant is invalid');
    const keys = Object.keys(value);
    if (keys.length !== 2 || !keys.includes('grantId') || !keys.includes('grantSecret')) {
        throw new BadRequestError('Student SSO grant is invalid');
    }
    const grant = value as { grantId: unknown; grantSecret: unknown };
    if (typeof grant.grantId !== 'string' || !UUID.test(grant.grantId)
        || typeof grant.grantSecret !== 'string' || grant.grantSecret.length === 0 || grant.grantSecret.length > 1024) {
        throw new BadRequestError('Student SSO grant is invalid');
    }
    return { grantId: grant.grantId, grantSecret: grant.grantSecret };
}

function linkBody(req: Request): { handoffId: string; handoffSecret: string; reauthGrant: { grantId: string; grantSecret: string } } {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestError('Student SSO link request is invalid');
    const keys = Object.keys(body);
    if (keys.length !== 3 || !keys.includes('handoffId') || !keys.includes('handoffSecret') || !keys.includes('reauthGrant')) {
        throw new BadRequestError('Student SSO link request is invalid');
    }
    const value = body as { handoffId: unknown; handoffSecret: unknown; reauthGrant: unknown };
    if (typeof value.handoffId !== 'string' || !UUID.test(value.handoffId)
        || typeof value.handoffSecret !== 'string' || value.handoffSecret.length === 0 || value.handoffSecret.length > 1024) {
        throw new BadRequestError('Student SSO link request is invalid');
    }
    return { handoffId: value.handoffId, handoffSecret: value.handoffSecret, reauthGrant: grantBody(value.reauthGrant) };
}

function unlinkBody(req: Request): { reauthGrant: { grantId: string; grantSecret: string } } {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestError('Student SSO unlink request is invalid');
    const keys = Object.keys(body);
    if (keys.length !== 1 || !keys.includes('reauthGrant')) {
        throw new BadRequestError('Student SSO unlink request is invalid');
    }
    return { reauthGrant: grantBody((body as { reauthGrant: unknown }).reauthGrant) };
}

function recoveryCodeBody(req: Request, action: 'generate' | 'activate' | 'remove'): {
    reauthGrant: { grantId: string; grantSecret: string };
    pendingCodeId?: string;
    code?: string;
    oldCode?: string;
} {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestError('Recovery-code request is invalid');
    const allowed = action === 'generate'
        ? new Set(['reauthGrant', 'oldCode'])
        : action === 'activate'
            ? new Set(['reauthGrant', 'pendingCodeId', 'code', 'oldCode'])
            : new Set(['reauthGrant', 'oldCode']);
    const value = body as Record<string, unknown>;
    if (!('reauthGrant' in value) || Object.keys(value).some((key) => !allowed.has(key))
        || (action === 'activate' && (!('pendingCodeId' in value) || !('code' in value)))
        || (action === 'remove' && !('oldCode' in value))
        || (value.oldCode !== undefined && (typeof value.oldCode !== 'string' || value.oldCode.length === 0 || value.oldCode.length > 1024))
        || (value.code !== undefined && (typeof value.code !== 'string' || value.code.length === 0 || value.code.length > 1024))
        || (value.pendingCodeId !== undefined && (typeof value.pendingCodeId !== 'string' || !UUID.test(value.pendingCodeId)))) {
        throw new BadRequestError('Recovery-code request is invalid');
    }
    return {
        reauthGrant: grantBody(value.reauthGrant),
        ...(typeof value.pendingCodeId === 'string' ? { pendingCodeId: value.pendingCodeId } : {}),
        ...(typeof value.code === 'string' ? { code: value.code } : {}),
        ...(typeof value.oldCode === 'string' ? { oldCode: value.oldCode } : {}),
    };
}

/** The owner plus their current session. Legacy tokens without a session id fail closed. */
function ssoActor(req: Request): { userId: string; sid: string } {
    const userId = req.user?.userId;
    const sid = req.user?.sid;
    if (typeof userId !== 'string' || !UUID.test(userId) || typeof sid !== 'string' || !UUID.test(sid)) {
        throw new UnauthorizedError('Student SSO session is not available');
    }
    return { userId, sid };
}

function ssoOwner(req: Request): { userId: string } {
    const userId = req.user?.userId;
    if (typeof userId !== 'string' || !UUID.test(userId)) {
        throw new UnauthorizedError('Student SSO session is not available');
    }
    return { userId };
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

// Link-confirmation endpoints (reauth, link, unlink) are limited
// independently of each other: each route gets its own instance so one
// exhausted bucket never blocks owner recovery on another.
function studentSsoLinkLimiter(max: number) {
    return rateLimit({
        windowMs: 10 * 60 * 1000,
        max,
        standardHeaders: true,
        legacyHeaders: false,
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
        isProviderEnabled: (provider) => enabledStudentSsoProviders(config.studentSso).includes(provider),
    });
}

function defaultLink(): StudentSsoLink {
    const sso = config.studentSso;
    // No factory-level key requirement: the key is null when every
    // provider is disabled, and owner recovery (list, unlink, reauth)
    // must keep working then. Only link() gates on the key.
    return new StudentSsoLinkService({
        pool: getPool(),
        attemptKey: sso.attemptKey,
        isEnabled: () => config.studentSso.google.enabled || config.studentSso.microsoft.enabled,
        isProviderEnabled: (provider) => enabledStudentSsoProviders(config.studentSso).includes(provider),
    });
}

function defaultReauth(): StudentReauthService {
    const sso = config.studentSso;
    if (!sso.attemptKey || !sso.completionUrl) throw new ServiceUnavailableError('Student SSO is unavailable');
    return new StudentReauthService({
        pool: getPool(), attemptKey: sso.attemptKey, completionUrl: sso.completionUrl,
        oidcForPolicy: (policy) => defaultOidc().forPolicy(policy),
        isProviderEnabled: (provider) => enabledStudentSsoProviders(sso).includes(provider),
    });
}
function defaultSignup(): StudentSsoSignupService {
    const sso = config.studentSso;
    return new StudentSsoSignupService({
        pool: getPool(), attemptKey: sso.attemptKey,
        isEnabled: () => config.passwordlessStudentSignupEnabled,
        isProviderEnabled: (provider) => enabledStudentSsoProviders(sso).includes(provider),
        deliverOtp: async (email, code, name, expiresAt) => sendEmailVerificationOTP(email, code, name || 'Student', 'student', Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 60000))),
    });
}
function defaultRecoveryCode(): StudentRecoveryCodeService {
    const key = config.studentAccountRecovery.codeKey;
    if (!key) throw new ServiceUnavailableError('Account recovery is unavailable');
    return new StudentRecoveryCodeService({ pool: getPool(), codeKey: key });
}
function defaultAccountRecovery(): StudentAccountRecoveryService {
    const key = config.studentAccountRecovery.codeKey;
    if (!key) throw new ServiceUnavailableError('Account recovery is unavailable');
    return new StudentAccountRecoveryService({
        pool: getPool(), recoveryCodeKey: key,
        deliverOtp: async (email, code) => sendEmail(email, 'Awoof email confirmation code', `<p>Your Awoof email confirmation code is <strong>${code}</strong>.</p><p>It expires shortly. If you did not start account recovery, ignore this email.</p>`),
    });
}

export function createStudentSsoRouter(factory: FlowFactory = defaultFlow, options: StudentSsoRouterOptions = {}): Router {
    const router = Router();
    const issuanceEnabled = options.isIssuanceEnabled
        ?? (() => config.studentSso.google.enabled || config.studentSso.microsoft.enabled);
    const providersEnabled = options.enabledProviders ?? (() => enabledStudentSsoProviders(config.studentSso));
    const completionOrigin = options.completionOrigin ?? config.studentSso.completionUrl?.origin;
    const recoveryAllowedOrigin = options.recoveryOrigin ?? new URL(config.frontend.url).origin;
    // Pools open per request only; mounting the router never connects.
    const poolForRequest = (): Pick<Pool, 'query'> => options.pool ?? getPool();
    const checkStartQuota = options.checkStartQuota ?? (async (clientIp: string, mailbox: string) => {
        const attemptKey = config.studentSso.attemptKey;
        if (!attemptKey) throw new ServiceUnavailableError('Student SSO is unavailable');
        await checkSsoStartQuota(createRedisQuotaStore(getRedisClient()), clientIp, mailbox, attemptKey);
    });
    const callbackLimiter = studentSsoCallbackLimiter(options.callbackLimiterMax ?? 60);
    const linkFactory = options.linkService ?? defaultLink;
    const signupFactory = options.signupService ?? defaultSignup;
    const signupEnabled = options.isSignupEnabled ?? (() => config.passwordlessStudentSignupEnabled);
    const reauthFactory = options.reauthService ?? defaultReauth;
    const recoveryCodeFactory = options.recoveryCodeService ?? defaultRecoveryCode;
    const accountRecoveryFactory = options.accountRecoveryService ?? defaultAccountRecovery;
    const linkLimiterMax = options.linkLimiterMax ?? 10;
    const reauthLimiter = studentSsoLinkLimiter(linkLimiterMax);
    const linkLimiter = studentSsoLinkLimiter(linkLimiterMax);
    const unlinkLimiter = studentSsoLinkLimiter(linkLimiterMax);
    const reauthMicrosoftLimiter = studentSsoLinkLimiter(linkLimiterMax);
    const signupLimiter = studentSsoLinkLimiter(linkLimiterMax);

    const signupHandoffBody = (req: Request): { handoffId: string; handoffSecret: string } => {
        const value = req.body as Record<string, unknown>;
        if (!value || Array.isArray(value) || typeof value.handoffId !== 'string' || !UUID.test(value.handoffId) || typeof value.handoffSecret !== 'string' || value.handoffSecret.length < 1 || value.handoffSecret.length > 1024) throw new BadRequestError('Passwordless signup request is invalid');
        return { handoffId: value.handoffId, handoffSecret: value.handoffSecret };
    };
    const signupBinding = async (req: Request, body: { handoffId: string; handoffSecret: string }) => {
        // Handoff IDs are distinct from callback-attempt IDs. Resolve only the
        // opaque attempt id, then pass its HttpOnly cookie value to the service
        // for the authoritative hash comparison under its transaction lock.
        const row = await poolForRequest().query<{ attempt_id: string }>('SELECT attempt_id FROM student_auth_link_handoffs WHERE id = $1', [body.handoffId]);
        return { ...body, browserBinding: parseBrowserCookies(req).find(cookie => cookie.name === studentSsoCookieName(row.rows[0]?.attempt_id ?? 'missing'))?.value ?? '' };
    };

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

    // Provider-independent recovery actions (password reauth, recovery-code
    // mutations) stay available when SSO issuance is disabled and no SSO
    // completion URL is configured, so they validate against the trusted
    // frontend origin instead of the optional SSO completion origin.
    const exactRecoveryOrigin = (req: Request, _res: Response, next: NextFunction): void => {
        if (req.header('origin') !== recoveryAllowedOrigin) {
            return next(new BadRequestError('Student SSO origin is invalid'));
        }
        next();
    };

    // Register before the provider-parametrized /:provider/start route.
    router.post('/account-recovery/start', exactJson, asyncHandler(async (req, res) => {
        const body = req.body as { email?: unknown; purpose?: unknown };
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 2 || typeof body.email !== 'string' || body.email.length > 255 || (body.purpose !== 'lost_access' && body.purpose !== 'compromise')) throw new BadRequestError('Account recovery request is invalid');
        const result = await accountRecoveryFactory().start({ email: body.email, purpose: body.purpose });
        responseHeaders(res); res.status(202).json({ success: true, data: result });
    }));
    router.post('/account-recovery/verify', exactJson, asyncHandler(async (req, res) => {
        const body = req.body as { attemptId?: unknown; secret?: unknown; code?: unknown; otp?: unknown };
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 4) throw new BadRequestError('Account recovery request is invalid');
        await accountRecoveryFactory().verify({ attemptId: body.attemptId, secret: body.secret, code: body.code, otp: body.otp }); responseHeaders(res); res.status(204).end();
    }));
    router.post('/account-recovery/complete', exactJson, asyncHandler(async (req, res) => {
        const body = req.body as { attemptId?: unknown; secret?: unknown; password?: unknown };
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 3) throw new BadRequestError('Account recovery request is invalid');
        await accountRecoveryFactory().complete({ attemptId: body.attemptId, secret: body.secret, password: body.password }); responseHeaders(res); res.status(204).end();
    }));

    router.post('/:provider/start', requireIssuance, exactOrigin, exactJson, asyncHandler(async (req, res) => {
        const provider = parseStudentSsoProvider(req.params.provider);
        if (!providersEnabled().includes(provider)) throw new NotFoundError('Student SSO is not available');
        const body = startBody(req);
        // Quota and issuance share one canonical mailbox: case and
        // whitespace variants must charge the same key the attempt uses.
        const mailbox = normalizeStudentLoginEmail(body.email);
        const clientIp = typeof req.ip === 'string' && req.ip !== '' ? req.ip : 'unknown';
        await checkStartQuota(clientIp, mailbox);
        const result = await factory().start({ provider, email: mailbox, ...(body.rememberMe === undefined ? {} : { rememberMe: body.rememberMe }), ...(body.returnPath === undefined ? {} : { returnPath: body.returnPath }) });
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

    // Bounded completion redirect for a callback that arrives while its
    // provider cannot serve: full outage (factory unavailable) or
    // mixed-provider rollback (only this provider disabled). Returns false
    // when no completion page is configured so the caller falls through.
    const outageRedirect = async (res: Response, provider: LoginProvider, state: string | null): Promise<boolean> => {
        const completionUrl = config.studentSso.completionUrl
            ?? (completionOrigin ? new URL(STUDENT_SSO_COMPLETION_PATH, completionOrigin) : undefined);
        if (!completionUrl) return false;
        const completed = await ssoUnavailableCompletion(poolForRequest(), completionUrl, provider, state);
        res.locals.outageRedirect = true;
        for (const name of completed.clearCookies) clearSsoCookie(res, name);
        res.redirect(303, completed.location);
        return true;
    };

    router.get('/:provider/callback', callbackLimiter, asyncHandler(async (req, res) => {
        responseHeaders(res);
        const provider = parseStudentSsoProvider(req.params.provider);
        const browserCookies = parseBrowserCookies(req);
        const callbackUrl = new URL(`${req.protocol}://${req.get('host')}${req.originalUrl}`);
        // Reauthentication shares the registered Microsoft callback and
        // dispatches only after its opaque state resolves to a reauth row.
        // It never reaches the ordinary login flow or issues a session.
        if (provider === 'microsoft') {
            const reauth = reauthFactory();
            const reauthCookie = await reauth.callbackCookieNameForState(callbackUrl.searchParams.get('state'));
            if (reauthCookie) {
                const result = await reauth.callback({
                    callbackUrl,
                    callbackCookie: browserCookies.find((cookie) => cookie.name === reauthCookie)?.value,
                });
                // Retain the browser binding through the completion-page
                // finish POST; finish consumes it and clears the cookie.
                res.redirect(303, result.completionUrl.href);
                return;
            }
        }
        let flow: StudentSsoFlow;
        try {
            flow = factory();
        } catch (error) {
            if (!(error instanceof ServiceUnavailableError)) throw error;
            if (await outageRedirect(res, provider, callbackUrl.searchParams.get('state'))) return;
            throw error;
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
            // Mixed-provider rollback: the factory still serves the live
            // provider, so this provider's gate rejected the callback. Land
            // the in-flight browser on the bounded completion page instead
            // of a bare JSON error that retains the callback cookie.
            if (!enabledStudentSsoProviders(config.studentSso).includes(provider)
                && await outageRedirect(res, provider, callbackUrl.searchParams.get('state'))) {
                return;
            }
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

    router.post('/signup/context', signupLimiter, exactOrigin, exactJson, asyncHandler(async (req, res) => {
        if (!signupEnabled()) throw new ConflictError('Passwordless signup is unavailable');
        if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length !== 2) throw new BadRequestError('Passwordless signup request is invalid');
        const body = signupHandoffBody(req); const result = await signupFactory().context(await signupBinding(req, body)); responseHeaders(res); res.json({ success: true, data: result });
    }));
    router.post('/signup/send-code', signupLimiter, exactOrigin, exactJson, asyncHandler(async (req, res) => {
        if (!signupEnabled()) throw new ConflictError('Passwordless signup is unavailable');
        if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length !== 2) throw new BadRequestError('Passwordless signup request is invalid');
        const body = signupHandoffBody(req); const result = await signupFactory().sendCode(await signupBinding(req, body)); responseHeaders(res); res.status(201).json({ success: true, data: result });
    }));
    router.post('/signup/verify-code', signupLimiter, exactOrigin, exactJson, asyncHandler(async (req, res) => {
        if (!signupEnabled()) throw new ConflictError('Passwordless signup is unavailable');
        const body = req.body as Record<string, unknown>; const handoff = signupHandoffBody(req);
        if (Object.keys(body).length !== 4 || typeof body.challengeId !== 'string' || typeof body.code !== 'string') throw new BadRequestError('Passwordless signup request is invalid');
        const result = await signupFactory().verifyCode({ ...await signupBinding(req, handoff), challengeId: body.challengeId, code: body.code }); responseHeaders(res); res.json({ success: true, data: result });
    }));
    router.post('/signup/complete', signupLimiter, exactOrigin, exactJson, asyncHandler(async (req, res) => {
        if (!signupEnabled()) throw new ConflictError('Passwordless signup is unavailable');
        const body = req.body as Record<string, unknown>; const handoff = signupHandoffBody(req);
        const allowed = new Set(['handoffId', 'handoffSecret', 'fullName', 'ageAttested', 'termsAccepted', 'termsVersion', 'verificationConsent', 'noticeVersion']);
        if (Object.keys(body).some(key => !allowed.has(key)) || Object.keys(body).length !== 8) throw new BadRequestError('Passwordless signup request is invalid');
        const bound = await signupBinding(req, handoff); const result = await signupFactory().complete({ ...bound, fullName: body.fullName, ageAttested: body.ageAttested, termsAccepted: body.termsAccepted, termsVersion: body.termsVersion, verificationConsent: body.verificationConsent, noticeVersion: body.noticeVersion }); responseHeaders(res); const linked = await poolForRequest().query<{ attempt_id: string }>('SELECT attempt_id FROM student_auth_link_handoffs WHERE id = $1', [handoff.handoffId]); clearSsoCookie(res, studentSsoCookieName(linked.rows[0]?.attempt_id ?? handoff.handoffId)); res.status(201).json({ success: true, data: result });
    }));

    router.post('/reauth', authenticate, requireRole('student'), reauthLimiter, exactRecoveryOrigin, exactJson, asyncHandler(async (req, res) => {
        const body = reauthBody(req);
        const actor = ssoActor(req);
        const result = await linkFactory().reauth({
            userId: actor.userId, sid: actor.sid, password: body.password, purpose: body.purpose,
            ...(body.targetIdentityId === undefined ? {} : { targetIdentityId: body.targetIdentityId }),
            ...(body.pendingCodeId === undefined ? {} : { pendingCodeId: body.pendingCodeId }),
        });
        responseHeaders(res);
        res.status(201).json({ success: true, data: result });
    }));

    router.post('/reauth/microsoft/start', authenticate, requireRole('student'), reauthMicrosoftLimiter, exactOrigin, exactJson, asyncHandler(async (req, res) => {
        const body = req.body as { purpose?: unknown; targetIdentityId?: unknown; pendingCodeId?: unknown };
        if (!body || typeof body !== 'object' || Array.isArray(body)
            || Object.keys(body).some((key) => key !== 'purpose' && key !== 'targetIdentityId' && key !== 'pendingCodeId')
            || (body.purpose !== 'link' && body.purpose !== 'unlink' && body.purpose !== 'recovery_code_generate' && body.purpose !== 'recovery_code_activate' && body.purpose !== 'recovery_code_remove')
            || (body.targetIdentityId !== undefined && (typeof body.targetIdentityId !== 'string' || !UUID.test(body.targetIdentityId)))
            || (body.pendingCodeId !== undefined && (typeof body.pendingCodeId !== 'string' || !UUID.test(body.pendingCodeId)))) throw new BadRequestError('Student SSO reauthentication request is invalid');
        const actor = ssoActor(req);
        const result = await reauthFactory().start({ userId: actor.userId, sid: actor.sid, purpose: body.purpose, ...(typeof body.targetIdentityId === 'string' ? { targetIdentityId: body.targetIdentityId } : {}), ...(typeof body.pendingCodeId === 'string' ? { pendingCodeId: body.pendingCodeId } : {}) });
        responseHeaders(res);
        res.cookie(studentReauthCookieName(result.attemptId), result.callbackCookie, { maxAge: 5 * 60_000, path: STUDENT_SSO_COOKIE_PATH, httpOnly: true, secure: true, sameSite: 'lax' });
        res.status(201).json({ success: true, data: { attemptId: result.attemptId, authorizationUrl: result.authorizationUrl } });
    }));

    router.post('/reauth/finish', authenticate, requireRole('student'), reauthMicrosoftLimiter, exactOrigin, exactJson, asyncHandler(async (req, res) => {
        const body = req.body as { attemptId?: unknown };
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.attemptId !== 'string' || !UUID.test(body.attemptId)) throw new BadRequestError('Student SSO reauthentication request is invalid');
        const attemptId = body.attemptId;
        const actor = ssoActor(req);
        const result = await reauthFactory().finish({ userId: actor.userId, sid: actor.sid, attemptId, callbackCookie: parseBrowserCookies(req).find((cookie) => cookie.name === studentReauthCookieName(attemptId))?.value });
        responseHeaders(res);
        clearSsoCookie(res, studentReauthCookieName(attemptId));
        res.status(201).json({ success: true, data: result });
    }));

    router.get('/recovery-code', authenticate, requireRole('student'), asyncHandler(async (req, res) => {
        const owner = ssoOwner(req);
        const result = await recoveryCodeFactory().status(owner);
        responseHeaders(res);
        res.json({ success: true, data: result });
    }));

    router.post('/recovery-code/generate', authenticate, requireRole('student'), reauthLimiter, exactRecoveryOrigin, exactJson, asyncHandler(async (req, res) => {
        const body = recoveryCodeBody(req, 'generate');
        const actor = ssoActor(req);
        const result = await recoveryCodeFactory().generate({
            userId: actor.userId, sid: actor.sid, grantId: body.reauthGrant.grantId, secret: body.reauthGrant.grantSecret,
            ...(body.oldCode === undefined ? {} : { oldCode: body.oldCode }),
        });
        responseHeaders(res);
        res.status(201).json({ success: true, data: result });
    }));

    router.post('/recovery-code/activate', authenticate, requireRole('student'), reauthLimiter, exactRecoveryOrigin, exactJson, asyncHandler(async (req, res) => {
        const body = recoveryCodeBody(req, 'activate');
        if (!body.pendingCodeId || !body.code) throw new BadRequestError('Recovery-code request is invalid');
        const actor = ssoActor(req);
        const result = await recoveryCodeFactory().activate({
            userId: actor.userId, sid: actor.sid, grantId: body.reauthGrant.grantId, secret: body.reauthGrant.grantSecret,
            pendingCodeId: body.pendingCodeId, code: body.code,
            ...(body.oldCode === undefined ? {} : { oldCode: body.oldCode }),
        });
        responseHeaders(res);
        res.json({ success: true, data: result });
    }));

    router.post('/recovery-code/remove', authenticate, requireRole('student'), reauthLimiter, exactRecoveryOrigin, exactJson, asyncHandler(async (req, res) => {
        const body = recoveryCodeBody(req, 'remove');
        if (!body.oldCode) throw new BadRequestError('Recovery-code request is invalid');
        const actor = ssoActor(req);
        await recoveryCodeFactory().remove({
            userId: actor.userId, sid: actor.sid, grantId: body.reauthGrant.grantId, secret: body.reauthGrant.grantSecret, oldCode: body.oldCode,
        });
        responseHeaders(res);
        res.status(204).end();
    }));

    router.post('/recovery-code/cancel', authenticate, requireRole('student'), exactRecoveryOrigin, exactJson, asyncHandler(async (req, res) => {
        const body = req.body as { pendingCodeId?: unknown };
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.pendingCodeId !== 'string' || !UUID.test(body.pendingCodeId)) throw new BadRequestError('Recovery-code request is invalid');
        const actor = ssoActor(req);
        await recoveryCodeFactory().cancel({ userId: actor.userId, sid: actor.sid, pendingCodeId: body.pendingCodeId });
        responseHeaders(res); res.status(204).end();
    }));

    router.post('/link', authenticate, requireRole('student'), linkLimiter, exactOrigin, exactJson, asyncHandler(async (req, res) => {
        const body = linkBody(req);
        const actor = ssoActor(req);
        const browserCookies = parseBrowserCookies(req);
        const result = await linkFactory().link({
            userId: actor.userId,
            sid: actor.sid,
            handoffId: body.handoffId,
            handoffSecret: body.handoffSecret,
            browserCookies,
            grantId: body.reauthGrant.grantId,
            grantSecret: body.reauthGrant.grantSecret,
        });
        responseHeaders(res);
        if (result.outcome === 'linked') {
            // The handoff binding is spent: clear the per-attempt cookie on a
            // successful link so per-attempt cookies cannot accumulate.
            clearSsoCookie(res, studentSsoCookieName(result.attemptId));
            res.status(result.reactivated ? 200 : 201).json({
                success: true,
                data: {
                    outcome: result.outcome,
                    identity: result.identity,
                    schoolAssertion: result.schoolAssertion,
                    reactivated: result.reactivated,
                },
            });
            return;
        }
        if (result.outcome === 'mismatch') {
            clearSsoCookie(res, studentSsoCookieName(result.attemptId));
            res.status(409).json({
                success: false,
                error: {
                    message: 'A different school account was returned. Restart student sign-in to try again.',
                    code: 'SSO_LINK_MISMATCH',
                    statusCode: 409,
                    details: { outcome: 'mismatch' },
                },
            });
            return;
        }
        if (result.attemptId) clearSsoCookie(res, studentSsoCookieName(result.attemptId));
        res.status(409).json({
            success: false,
            error: {
                message: 'Student SSO link is no longer valid. Restart provider linking to try again.',
                code: 'SSO_RESTART_REQUIRED',
                statusCode: 409,
                details: { outcome: 'restart_required' },
            },
        });
    }));

    router.get('/identities', authenticate, requireRole('student'), asyncHandler(async (req, res) => {
        const owner = ssoOwner(req);
        const identities = await linkFactory().listIdentities(owner.userId);
        responseHeaders(res);
        res.json({ success: true, data: { identities } });
    }));

    router.post('/identities/:id/unlink', authenticate, requireRole('student'), unlinkLimiter, exactOrigin, exactJson, asyncHandler(async (req, res) => {
        if (typeof req.params.id !== 'string' || !UUID.test(req.params.id)) {
            throw new BadRequestError('Student SSO unlink request is invalid');
        }
        const body = unlinkBody(req);
        const actor = ssoActor(req);
        const result = await linkFactory().unlink({
            userId: actor.userId,
            sid: actor.sid,
            identityId: req.params.id,
            grantId: body.reauthGrant.grantId,
            grantSecret: body.reauthGrant.grantSecret,
        });
        responseHeaders(res);
        if ('outcome' in result) {
            res.status(409).json({
                success: false,
                error: {
                    message: 'Removing this sign-in would lock the account. Keep another sign-in method first.',
                    code: 'SSO_LAST_LOGIN_METHOD',
                    statusCode: 409,
                    details: { outcome: 'last_method' },
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
 * /api/auth/student/sso/reauth:
 *   post:
 *     summary: Prove the current student account with its password
 *     description: >
 *       Strict JSON. Issues a five-minute single-use grant bound to the
 *       current user, session, and purpose (link or unlink). A password
 *       reset or session replacement invalidates the grant. This release
 *       requires an active usable password. School-account assurance and
 *       enrollment eligibility stay separate; reauthentication never
 *       authorizes benefits.
 *     tags: [Authentication]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [password, purpose]
 *             properties:
 *               password: { type: string }
 *               purpose: { type: string, enum: [link, unlink] }
 *     responses:
 *       201:
 *         description: Single-use reauthentication grant
 *         headers:
 *           Cache-Control: { schema: { type: string, example: no-store } }
 *         content: { application/json: { schema: { $ref: '#/components/schemas/StudentSsoReauthResponse' } } }
 *       400: { description: Invalid body, origin, or content type }
 *       401: { description: Authentication failed or session unavailable }
 *       403: { description: Password reauthentication is not available for this account }
 *       409: { description: Link-purpose reauthentication is unavailable while providers are disabled }
 *       429: { description: Too many reauthentication requests }
 * /api/auth/student/sso/link:
 *   post:
 *     summary: Link an unlinked provider handoff to the proven owner
 *     description: >
 *       Strict JSON with the tab-held handoff secrets, the browser callback
 *       cookie, and a link-purpose reauthentication grant. Links a new
 *       subject or reactivates a revoked subject for the original owner
 *       only; never auto-links by email and never transfers ownership. A
 *       different returned Google account is an explicit mismatch
 *       (SSO_LINK_MISMATCH). Linking never authorizes enrollment benefits.
 *     tags: [Authentication]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [handoffId, handoffSecret, reauthGrant]
 *             properties:
 *               handoffId: { type: string, format: uuid }
 *               handoffSecret: { type: string }
 *               reauthGrant:
 *                 type: object
 *                 additionalProperties: false
 *                 required: [grantId, grantSecret]
 *                 properties:
 *                   grantId: { type: string, format: uuid }
 *                   grantSecret: { type: string }
 *     responses:
 *       201:
 *         description: Provider identity linked
 *         headers:
 *           Cache-Control: { schema: { type: string, example: no-store } }
 *           Set-Cookie: { schema: { type: string, example: awoof_sso_<attemptId>=; Path=/api/auth/student/sso } }
 *         content: { application/json: { schema: { $ref: '#/components/schemas/StudentSsoLinkResponse' } } }
 *       200: { description: Revoked identity reactivated for the original owner }
 *       400: { description: Invalid body, origin, or content type }
 *       401: { description: Authentication failed or session unavailable }
 *       409: { description: Link invalid, already linked, mismatch (SSO_LINK_MISMATCH), or restart required (SSO_RESTART_REQUIRED) }
 *       429: { description: Too many link requests }
 * /api/auth/student/sso/identities:
 *   get:
 *     summary: List the owner's linked school sign-ins
 *     description: >
 *       Owner-only listing of active provider identities with provider,
 *       institution, and linked time. Subject and issuer material is never
 *       exposed. Available while providers are disabled so owner recovery
 *       keeps working.
 *     tags: [Authentication]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Active linked identities
 *         headers:
 *           Cache-Control: { schema: { type: string, example: no-store } }
 *         content: { application/json: { schema: { $ref: '#/components/schemas/StudentSsoIdentitiesResponse' } } }
 *       401: { description: Authentication failed }
 * /api/auth/student/sso/identities/{id}/unlink:
 *   post:
 *     summary: Revoke one linked school sign-in
 *     description: >
 *       Strict JSON with an unlink-purpose reauthentication grant. Revokes
 *       the login identity and its school assertions, and clears the active
 *       session only when it was issued by the removed identity. Requires
 *       another usable login method (SSO_LAST_LOGIN_METHOD otherwise).
 *       Independent enrollment consents are never mutated. Available while
 *       providers are disabled.
 *     tags: [Authentication]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [reauthGrant]
 *             properties:
 *               reauthGrant:
 *                 type: object
 *                 additionalProperties: false
 *                 required: [grantId, grantSecret]
 *                 properties:
 *                   grantId: { type: string, format: uuid }
 *                   grantSecret: { type: string }
 *     responses:
 *       200: { description: Identity revoked }
 *       400: { description: Invalid body, origin, or content type }
 *       401: { description: Authentication failed or session unavailable }
 *       404: { description: Login identity not found }
 *       409: { description: Unlink invalid or last login method (SSO_LAST_LOGIN_METHOD) }
 *       429: { description: Too many unlink requests }
 * /api/auth/student/sso/signup/context:
 *   post:
 *     summary: Read a pending passwordless signup handoff
 *     description: Disabled unless the server enables passwordless signup. Requires the opaque handoff ID and tab-held secret; it never proves current enrollment or returns provider tokens.
 *     tags: [Authentication]
 *     security: []
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { $ref: '#/components/schemas/PasswordlessSignupHandoffRequest' } } }
 *     responses:
 *       200: { description: Pending signup context, no-store, content: { application/json: { schema: { $ref: '#/components/schemas/PasswordlessSignupContextResponse' } } } }
 *       400: { description: JSON, exact-origin, or opaque handoff binding failure }
 *       409: { description: Disabled, expired, consumed, replayed, or invalid handoff, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       429: { description: Signup quota exhausted }
 * /api/auth/student/sso/signup/send-code:
 *   post:
 *     summary: Send a mailbox confirmation code for a pending passwordless signup
 *     description: Disabled unless server signup issuance is enabled. The code confirms mailbox control only, not current enrollment.
 *     tags: [Authentication]
 *     security: []
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { $ref: '#/components/schemas/PasswordlessSignupHandoffRequest' } } }
 *     responses:
 *       201: { description: Confirmation challenge created, no-store, content: { application/json: { schema: { $ref: '#/components/schemas/PasswordlessSignupCodeResponse' } } } }
 *       400: { description: JSON, exact-origin, or opaque handoff binding failure }
 *       409: { description: Disabled, invalid handoff, replay, or resend limit, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       429: { description: Signup quota exhausted }
 * /api/auth/student/sso/signup/verify-code:
 *   post:
 *     summary: Verify the pending signup mailbox confirmation code
 *     tags: [Authentication]
 *     security: []
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { $ref: '#/components/schemas/PasswordlessSignupVerifyRequest' } } }
 *     responses:
 *       200: { description: Mailbox confirmation accepted, no-store, content: { application/json: { schema: { $ref: '#/components/schemas/PasswordlessSignupVerifiedResponse' } } } }
 *       400: { description: JSON, exact-origin, malformed, or stale proof }
 *       409: { description: Disabled, expired, consumed, replayed, or invalid signup state, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       429: { description: Signup quota exhausted }
 * /api/auth/student/sso/signup/complete:
 *   post:
 *     summary: Complete a confirmed passwordless student account
 *     description: Disabled unless server signup issuance is enabled. Requires the current Terms and processing-notice assent. Login and mailbox control do not authorize benefits.
 *     tags: [Authentication]
 *     security: []
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { $ref: '#/components/schemas/PasswordlessSignupCompleteRequest' } } }
 *     responses:
 *       201: { description: Account and session created, no-store, content: { application/json: { schema: { $ref: '#/components/schemas/PasswordlessSignupCompleteResponse' } } } }
 *       400: { description: JSON, exact-origin, required assent, or malformed request }
 *       409: { description: Disabled, consumed, expired, replayed, or invalid signup state, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       429: { description: Signup quota exhausted }
 * /api/auth/student/sso/recovery-code:
 *   get:
 *     summary: Read owner recovery-code status
 *     description: Returns status and generation metadata only; never returns a recovery-code digest or plaintext.
 *     tags: [Authentication]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Owner recovery-code status, no-store, content: { application/json: { schema: { $ref: '#/components/schemas/RecoveryCodeStatusResponse' } } } }
 *       401: { description: Missing, invalid, or non-student bearer session }
 * /api/auth/student/sso/recovery-code/generate:
 *   post:
 *     summary: Generate a pending recovery code after fresh reauthentication
 *     tags: [Authentication]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { $ref: '#/components/schemas/RecoveryCodeGenerateRequest' } } }
 *     responses:
 *       201: { description: One-time display response, no-store, content: { application/json: { schema: { $ref: '#/components/schemas/RecoveryCodeGeneratedResponse' } } } }
 *       400: { description: JSON, exact-origin, or malformed request }
 *       401: { description: Missing, invalid, or non-student bearer session }
 *       409: { description: Invalid, expired, consumed, revoked, or replayed fresh grant, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       429: { description: Fresh-proof quota exhausted }
 * /api/auth/student/sso/recovery-code/activate:
 *   post:
 *     summary: Activate a pending recovery code after a second fresh proof
 *     tags: [Authentication]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { $ref: '#/components/schemas/RecoveryCodeActivateRequest' } } }
 *     responses:
 *       200: { description: Recovery code activated, no-store, content: { application/json: { schema: { $ref: '#/components/schemas/RecoveryCodeActivatedResponse' } } } }
 *       400: { description: JSON, exact-origin, or malformed request }
 *       401: { description: Missing, invalid, or non-student bearer session }
 *       409: { description: Invalid, expired, consumed, revoked, or replayed code/grant, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       429: { description: Fresh-proof quota exhausted }
 * /api/auth/student/sso/recovery-code/remove:
 *   post:
 *     summary: Remove an active recovery code after fresh reauthentication
 *     tags: [Authentication]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { $ref: '#/components/schemas/RecoveryCodeRemoveRequest' } } }
 *     responses:
 *       204: { description: Recovery code removed }
 *       400: { description: JSON, exact-origin, or malformed request }
 *       401: { description: Missing, invalid, or non-student bearer session }
 *       409: { description: Invalid, expired, consumed, revoked, or replayed fresh grant }
 *       429: { description: Fresh-proof quota exhausted }
 * /api/auth/student/sso/account-recovery/start:
 *   post:
 *     summary: Start independent password recovery
 *     description: Requires an explicit lost-access or compromise purpose. Mailbox access alone never transfers account ownership.
 *     tags: [Authentication]
 *     security: []
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { $ref: '#/components/schemas/AccountRecoveryStartRequest' } } }
 *     responses:
 *       202: { description: Recovery handle issued, no-store, content: { application/json: { schema: { $ref: '#/components/schemas/AccountRecoveryStartResponse' } } } }
 *       400: { description: JSON or malformed explicit-purpose request }
 *       409: { description: Expired, unavailable, or conflict recovery state }
 *       429: { description: Recovery quota exhausted }
 * /api/auth/student/sso/account-recovery/verify:
 *   post:
 *     summary: Verify both recovery-code and mailbox proofs
 *     tags: [Authentication]
 *     security: []
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { $ref: '#/components/schemas/AccountRecoveryVerifyRequest' } } }
 *     responses:
 *       204: { description: Recovery proofs accepted }
 *       400: { description: JSON or malformed proof request }
 *       409: { description: Expired, invalid, consumed, or replayed recovery proof }
 *       429: { description: Recovery quota exhausted }
 * /api/auth/student/sso/account-recovery/complete:
 *   post:
 *     summary: Set a password after verified independent recovery
 *     description: Never issues a session or eligibility benefit; normal sign-in follows completion.
 *     tags: [Authentication]
 *     security: []
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { $ref: '#/components/schemas/AccountRecoveryCompleteRequest' } } }
 *     responses:
 *       204: { description: Password set without issuing a session }
 *       400: { description: JSON or malformed completion request }
 *       409: { description: Expired, invalid, consumed, or replayed recovery proof }
 *       429: { description: Recovery quota exhausted }
 */
