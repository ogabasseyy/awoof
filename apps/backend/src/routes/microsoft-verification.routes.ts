import { Router, type NextFunction, type Request, type Response } from 'express';
import { BadRequestError, ServiceUnavailableError } from '../common/errors/AppError.js';
import { asyncHandler } from '../common/middleware/errorHandler.js';
import { config } from '../config/env.js';
import { getPool } from '../config/database.js';
import { requireMicrosoftSession } from '../middleware/microsoft-session.js';
import { withMicrosoftSession } from '../services/verification/microsoft-session.service.js';
import { acceptMicrosoftConsent, getMicrosoftConsentNotice, listMicrosoftConsents, withdrawMicrosoftConsent } from '../services/verification/microsoft-consent.service.js';
import { listMicrosoftIdentities } from '../services/verification/microsoft-identity.service.js';
import { unlinkMicrosoftIdentity } from '../services/verification/microsoft-identity-unlink.service.js';
import { MicrosoftFlowService } from '../services/verification/microsoft-flow.service.js';
import { MicrosoftOidcService, type MicrosoftOidc } from '../services/verification/microsoft-oidc.service.js';
import { forApprovedMicrosoftTenant } from '../services/verification/microsoft-oidc.config.js';
import { MicrosoftEducationService } from '../services/verification/microsoft-education.service.js';
import { hasValidMicrosoftAttemptEncryptionKey } from '../services/verification/microsoft-attempt-crypto.js';

type Flow = Pick<MicrosoftFlowService, 'start' | 'callback' | 'finish'> & Partial<Pick<MicrosoftFlowService, 'callbackCookieNameForState'>>;
type FlowFactory = () => Flow;
type RouterOptions = { isIssuanceEnabled?: () => boolean };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

export function bodyIds(req: Request, names: readonly string[]): Record<string, string> {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== names.length
        || names.some((name) => typeof body[name] !== 'string' || body[name].length === 0 || body[name].length > 200)) {
        throw new BadRequestError('Microsoft verification request is invalid');
    }
    const values = body as Record<string, string>;
    // finishSecret stays an opaque string; every other ID maps to a UUID column.
    if (names.some((name) => name !== 'finishSecret' && !UUID.test(values[name]!))) {
        throw new BadRequestError('Microsoft verification request is invalid');
    }
    return values;
}

function consentBody(req: Request): { processingGrantId: string; snapshot: { universityId: string; providerPolicyVersion: number; noticeVersion: string; mode: 'identity_only' | 'graph_enrollment'; scopes: string[] }; accepted: true } {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).length !== 3 || body.accepted !== true || typeof body.processingGrantId !== 'string' || !UUID.test(body.processingGrantId)
        || !body.snapshot || typeof body.snapshot !== 'object' || Array.isArray(body.snapshot)) {
        throw new BadRequestError('Microsoft consent request is invalid');
    }
    const snapshot = body.snapshot as Record<string, unknown>;
    if (Object.keys(snapshot).length !== 5 || typeof snapshot.universityId !== 'string' || !UUID.test(snapshot.universityId)
        || !Number.isInteger(snapshot.providerPolicyVersion) || (typeof snapshot.noticeVersion !== 'string' || !snapshot.noticeVersion.trim())
        || (snapshot.mode !== 'identity_only' && snapshot.mode !== 'graph_enrollment') || !Array.isArray(snapshot.scopes)
        || snapshot.scopes.some((scope) => typeof scope !== 'string' || !scope.trim())) {
        throw new BadRequestError('Microsoft consent request is invalid');
    }
    return { processingGrantId: body.processingGrantId, accepted: true, snapshot: {
        universityId: snapshot.universityId as string, providerPolicyVersion: snapshot.providerPolicyVersion as number,
        noticeVersion: snapshot.noticeVersion as string, mode: snapshot.mode as 'identity_only' | 'graph_enrollment', scopes: [...snapshot.scopes] as string[],
    } };
}

function emptyBody(req: Request): void {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) {
        throw new BadRequestError('Microsoft withdrawal request is invalid');
    }
}

function consentId(value: string | string[] | undefined): string {
    const id = Array.isArray(value) ? value[0] : value;
    if (!id || !UUID.test(id)) throw new BadRequestError('Microsoft consent ID is invalid');
    return id;
}

function responseHeaders(res: Response): void {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
}

function defaultFlow(): Flow {
    const oidcConfig = config.microsoftOidc;
    const key = config.microsoftVerification.attemptEncryptionKey;
    if (!oidcConfig.enabled || !hasValidMicrosoftAttemptEncryptionKey(key)) throw new ServiceUnavailableError('Microsoft verification is unavailable');
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
        education: new MicrosoftEducationService(),
    });
}

export function createMicrosoftVerificationRouter(factory: FlowFactory = defaultFlow, options: RouterOptions = {}): Router {
    const router = Router();
    const issuanceEnabled = options.isIssuanceEnabled ?? (() => config.microsoftOidc.enabled
        && hasValidMicrosoftAttemptEncryptionKey(config.microsoftVerification.attemptEncryptionKey));
    const assertIssuanceEnabled = (): void => {
        if (!issuanceEnabled()) throw new ServiceUnavailableError('Microsoft verification is unavailable');
    };

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

    router.get('/notice', requireMicrosoftSession('issuance'), asyncHandler(async (req, res) => {
        const result = await withMicrosoftSession(getPool(), { userId: req.user!.id, sid: req.user!.sid, use: 'issuance' }, async (tx) => {
            assertIssuanceEnabled();
            const notice = await getMicrosoftConsentNotice(tx, req.user!.id);
            // Recheck after canonical user/student/policy locks so a runtime
            // feature disable cannot yield a newly actionable notice.
            assertIssuanceEnabled();
            return notice;
        });
        responseHeaders(res);
        res.json({ success: true, data: result });
    }));

    router.post('/consents', exactOrigin, exactJson, requireMicrosoftSession('issuance'), asyncHandler(async (req, res) => {
        const input = consentBody(req);
        const providerConsentId = await withMicrosoftSession(getPool(), { userId: req.user!.id, sid: req.user!.sid, use: 'issuance' }, async (tx) => {
            assertIssuanceEnabled();
            const id = await acceptMicrosoftConsent(tx, req.user!.id, input);
            // acceptMicrosoftConsent has already locked parent consent before
            // policy. Keep that canonical order; a legacy notice causes the
            // enclosing transaction (including this new grant) to roll back.
            await getMicrosoftConsentNotice(tx, req.user!.id);
            assertIssuanceEnabled();
            return id;
        });
        responseHeaders(res);
        res.status(201).json({ success: true, data: { providerConsentId } });
    }));

    router.get('/consents', requireMicrosoftSession('owner'), asyncHandler(async (req, res) => {
        const rawCursor = Array.isArray(req.query.cursor) ? req.query.cursor[0] : req.query.cursor;
        if (rawCursor !== undefined && (typeof rawCursor !== 'string' || !UUID.test(rawCursor))) {
            throw new BadRequestError('Microsoft consent cursor is invalid');
        }
        const result = await withMicrosoftSession(getPool(), { userId: req.user!.id, sid: req.user!.sid, use: 'owner' }, (tx) =>
            listMicrosoftConsents(tx, req.user!.id, rawCursor),
        );
        responseHeaders(res);
        res.json({ success: true, data: result });
    }));

    router.post('/consents/:id/withdraw', exactOrigin, exactJson, requireMicrosoftSession('owner'), asyncHandler(async (req, res) => {
        emptyBody(req);
        const id = consentId(req.params.id);
        await withMicrosoftSession(getPool(), { userId: req.user!.id, sid: req.user!.sid, use: 'owner' }, async (tx) => {
            await withdrawMicrosoftConsent(tx, req.user!.id, id);
        });
        responseHeaders(res);
        res.json({ success: true, data: { providerConsentId: id, withdrawn: true } });
    }));

    router.get('/identities', requireMicrosoftSession('owner'), asyncHandler(async (req, res) => {
        const rawCursor = Array.isArray(req.query.cursor) ? req.query.cursor[0] : req.query.cursor;
        if (rawCursor !== undefined && (typeof rawCursor !== 'string' || !UUID.test(rawCursor))) {
            throw new BadRequestError('Microsoft identity cursor is invalid');
        }
        // Deliberately no issuance/policy gate: owner recovery reads stay
        // available during feature or institution-policy rollback.
        const result = await withMicrosoftSession(getPool(), { userId: req.user!.id, sid: req.user!.sid, use: 'owner' }, (tx) =>
            listMicrosoftIdentities(tx, req.user!.id, rawCursor),
        );
        responseHeaders(res);
        res.json({ success: true, data: result });
    }));

    router.post('/identities/:id/unlink', exactOrigin, exactJson, requireMicrosoftSession('owner'), asyncHandler(async (req, res) => {
        emptyBody(req);
        const id = consentId(req.params.id);
        // Deliberately no issuance/policy gate: a valid owner session must be
        // able to sever a stored Microsoft link during feature rollback.
        const result = await withMicrosoftSession(getPool(), { userId: req.user!.id, sid: req.user!.sid, use: 'owner' }, (tx) =>
            unlinkMicrosoftIdentity(tx, req.user!.id, id),
        );
        responseHeaders(res);
        res.json({ success: true, data: result });
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

/**
 * @swagger
 * /api/verification/microsoft/start:
 *   post:
 *     summary: Begin a two-stage Microsoft account connection
 *     description: Strict JSON with server-held consent IDs only. Returns an opaque attempt ID, authorization URL, and bounded finish secret; never returns or logs Microsoft tokens, codes, PKCE material, or client secrets.
 *     tags: [Microsoft verification]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [processingGrantId, providerConsentId]
 *             properties:
 *               processingGrantId: { type: string, format: uuid }
 *               providerConsentId: { type: string, format: uuid }
 *     responses:
 *       201:
 *         description: Pending account-link attempt; completion remains a separate finish call
 *         content: { application/json: { schema: { $ref: '#/components/schemas/MicrosoftStartResponse' } } }
 *       400: { $ref: '#/components/responses/MicrosoftRequestError' }
 *       401: { $ref: '#/components/responses/MicrosoftRequestError' }
 *       503: { $ref: '#/components/responses/MicrosoftRequestError' }
 * /api/verification/microsoft/finish:
 *   post:
 *     summary: Finalize a ready Microsoft account-link attempt
 *     description: "Strict JSON. The result distinguishes account linking from enrollment assurance: enrollment is not_checked, eligible, unconfirmed, or denied. Never send provider credentials in this request or response."
 *     tags: [Microsoft verification]
 *     security: [{ bearerAuth: [] }]
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
 *         description: Minimal account-link and enrollment-assurance receipt
 *         content: { application/json: { schema: { $ref: '#/components/schemas/MicrosoftFinishResponse' } } }
 *       400: { $ref: '#/components/responses/MicrosoftRequestError' }
 *       401: { $ref: '#/components/responses/MicrosoftRequestError' }
 *       409: { $ref: '#/components/responses/MicrosoftRequestError' }
 * /api/verification/microsoft/notice:
 *   get:
 *     summary: Read the exact immutable Microsoft consent notice for the signed-in student
 *     tags: [Microsoft verification]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Server-selected snapshot and the immutable text that must be rendered before acceptance
 *         content: { application/json: { schema: { $ref: '#/components/schemas/MicrosoftNoticeResponse' } } }
 *       401: { $ref: '#/components/responses/MicrosoftRequestError' }
 *       503: { $ref: '#/components/responses/MicrosoftRequestError' }
 * /api/verification/microsoft/consents:
 *   get:
 *     summary: List the signed-in owner's Microsoft consent history
 *     tags: [Microsoft verification]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: cursor
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Owner-scoped keyset page with items and nullable nextCursor
 *         content: { application/json: { schema: { $ref: '#/components/schemas/MicrosoftConsentHistoryResponse' } } }
 *       400: { $ref: '#/components/responses/MicrosoftRequestError' }
 *       401: { $ref: '#/components/responses/MicrosoftRequestError' }
 *   post:
 *     summary: Explicitly accept the exact Microsoft notice snapshot that was rendered
 *     description: Strict JSON only. Client snapshot values are comparison values, never provider authority. A 409 requires a fresh render and explicit action; tokens, authorization codes, and client secrets are never accepted or logged.
 *     tags: [Microsoft verification]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [accepted, processingGrantId, snapshot]
 *             properties:
 *               accepted: { type: boolean, enum: [true] }
 *               processingGrantId: { type: string, format: uuid }
 *               snapshot:
 *                 type: object
 *                 additionalProperties: false
 *                 required: [universityId, providerPolicyVersion, noticeVersion, mode, scopes]
 *                 properties:
 *                   universityId: { type: string, format: uuid }
 *                   providerPolicyVersion: { type: integer, minimum: 1 }
 *                   noticeVersion: { type: string }
 *                   mode: { type: string, enum: [identity_only, graph_enrollment] }
 *                   scopes: { type: array, items: { type: string } }
 *     responses:
 *       201:
 *         description: Provider consent recorded; response data contains providerConsentId
 *         content: { application/json: { schema: { $ref: '#/components/schemas/MicrosoftConsentAcceptanceResponse' } } }
 *       400: { $ref: '#/components/responses/MicrosoftRequestError' }
 *       409: { $ref: '#/components/responses/MicrosoftRequestError' }
 *       503: { $ref: '#/components/responses/MicrosoftRequestError' }
 * /api/verification/microsoft/consents/{id}/withdraw:
 *   post:
 *     summary: Idempotently withdraw an owner-scoped Microsoft provider consent
 *     description: Requires exact configured Origin and an empty JSON object. It remains available with Microsoft issuance disabled and does not withdraw independent email evidence or merchant disclosure. Account linking is distinct from the enrollment assurance label returned by finish.
 *     tags: [Microsoft verification]
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
 *           schema: { type: object, additionalProperties: false }
 *     responses:
 *       200:
 *         description: Withdrawal completed or was already completed
 *         content: { application/json: { schema: { $ref: '#/components/schemas/MicrosoftConsentWithdrawalResponse' } } }
 *       400: { $ref: '#/components/responses/MicrosoftRequestError' }
 *       401: { $ref: '#/components/responses/MicrosoftRequestError' }
 *       403: { $ref: '#/components/responses/MicrosoftRequestError' }
 * /api/verification/microsoft/identities:
 *   get:
 *     summary: List owner-scoped Microsoft connection resources
 *     description: Returns only opaque resource IDs, institution display details, connection/revocation timestamps, and status. It remains available when Microsoft issuance or institution policy is disabled; it never returns provider tenant, object, claims, or token data.
 *     tags: [Microsoft verification]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: cursor
 *         required: false
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Bounded owner connection history
 *         content: { application/json: { schema: { $ref: '#/components/schemas/MicrosoftIdentityHistoryResponse' } } }
 *       400: { $ref: '#/components/responses/MicrosoftRequestError' }
 *       401: { $ref: '#/components/responses/MicrosoftRequestError' }
 * /api/verification/microsoft/identities/{id}/unlink:
 *   post:
 *     summary: Explicitly unlink one owner-scoped Microsoft identity
 *     description: Requires exact configured Origin and an empty JSON object. It remains available when Microsoft issuance or institution policy is disabled. It revokes dependent Microsoft evidence but leaves independent email evidence and merchant audit records intact. The revoked identity is kept as a tombstone and cannot be silently restored or transferred; support is required for any future recovery.
 *     tags: [Microsoft verification]
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
 *           schema: { type: object, additionalProperties: false }
 *     responses:
 *       200:
 *         description: Unlink completed or was already completed
 *         content: { application/json: { schema: { $ref: '#/components/schemas/MicrosoftIdentityUnlinkResponse' } } }
 *       400: { $ref: '#/components/responses/MicrosoftRequestError' }
 *       401: { $ref: '#/components/responses/MicrosoftRequestError' }
 *       403: { $ref: '#/components/responses/MicrosoftRequestError' }
 *       404: { $ref: '#/components/responses/MicrosoftRequestError' }
 *       500: { $ref: '#/components/responses/MicrosoftRequestError' }
 */
