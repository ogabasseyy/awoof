import type { Request, Response } from 'express';
import { z } from 'zod';
import {
    AppError,
    BadRequestError,
    ServiceUnavailableError,
} from '../common/errors/AppError.js';
import { success } from '../common/utils/response.js';
import type { AuthRequest } from '../middleware/auth.middleware.js';
import {
    verificationFlowService,
    VerificationFlowRateLimitError,
    type VerificationFlowService,
} from '../services/verification/verification-flow.service.js';
import {
    getAvailableVerificationMethods,
    type VerificationMethodInfo,
} from '../services/verification/verification-orchestrator.service.js';

const initiateSchema = z.object({
    universityId: z.string().uuid('Invalid university ID'),
    accepted: z.literal(true),
    noticeVersion: z.string().min(1).max(100),
}).strict();

const emailRequestSchema = z.object({
    processingGrantId: z.string().uuid('Invalid processing grant ID'),
}).strict();

const emailConfirmSchema = z.object({
    challengeId: z.string().uuid('Invalid challenge ID'),
    otp: z.string().regex(/^\d{6}$/, 'Verification OTP must be six digits'),
}).strict();

const disclosureSchema = z.object({
    vendorId: z.string().uuid('Invalid merchant ID'),
    origin: z.string().min(1).max(2048),
    purpose: z.string().min(1).max(1024),
    accepted: z.literal(true),
    noticeVersion: z.string().min(1).max(100),
}).strict();

const consentIdSchema = z.string().uuid('Invalid consent ID');
const universityIdSchema = z.string().uuid('Invalid university ID');

type VerificationControllerDependencies = {
    flow?: VerificationFlowService;
    getAvailableMethods?: (universityId: string) => Promise<VerificationMethodInfo[]>;
};

function authenticatedUserId(req: AuthRequest): string {
    const userId = req.user?.userId;
    if (typeof userId !== 'string' || userId.length === 0) {
        throw new BadRequestError('Authenticated user identity required');
    }
    return userId;
}

function setRetryAfter(res: Response, error: unknown): void {
    if (!(error instanceof VerificationFlowRateLimitError)) return;
    const seconds = Math.max(1, Math.ceil((error.retryAt.getTime() - Date.now()) / 1000));
    res.set('Retry-After', String(seconds));
}

/**
 * HTTP adapter for authenticated verification flows. Identity always comes
 * from authenticate middleware; route bodies deliberately contain no email,
 * student ID, name, telephone, or registration identity fields.
 */
export class VerificationController {
    private readonly flow: VerificationFlowService;
    private readonly getAvailableMethods: (universityId: string) => Promise<VerificationMethodInfo[]>;

    constructor(dependencies: VerificationControllerDependencies = {}) {
        this.flow = dependencies.flow ?? verificationFlowService;
        this.getAvailableMethods = dependencies.getAvailableMethods ?? getAvailableVerificationMethods;
    }

    public async getVerificationMethods(req: Request, res: Response): Promise<void> {
        const universityId = Array.isArray(req.params.universityId) ? req.params.universityId[0] : req.params.universityId;
        if (!universityId) throw new BadRequestError('University ID is required');
        const canonicalUniversityId = universityIdSchema.parse(universityId);
        success(res, {
            message: 'Verification methods retrieved successfully',
            data: { universityId: canonicalUniversityId, methods: await this.getAvailableMethods(canonicalUniversityId) },
        });
    }

    public async initiateVerification(req: AuthRequest, res: Response): Promise<void> {
        const input = initiateSchema.parse(req.body);
        const result = await this.flow.initiate(authenticatedUserId(req), input);
        success(res, { message: 'Verification processing consent recorded', data: result });
    }

    public async requestEmailVerification(req: AuthRequest, res: Response): Promise<void> {
        const input = emailRequestSchema.parse(req.body);
        try {
            const result = await this.flow.requestEmail(authenticatedUserId(req), input);
            success(res, { message: 'Verification code sent', data: result });
        } catch (error) {
            setRetryAfter(res, error);
            throw error;
        }
    }

    public async confirmEmailVerification(req: AuthRequest, res: Response): Promise<void> {
        const input = emailConfirmSchema.parse(req.body);
        try {
            const eligibility = await this.flow.confirmEmail(authenticatedUserId(req), input);
            success(res, { message: 'Student email assurance recorded', data: { eligibility } });
        } catch (error) {
            setRetryAfter(res, error);
            throw error;
        }
    }

    public async getCurrentStatus(req: AuthRequest, res: Response): Promise<void> {
        const result = await this.flow.status(authenticatedUserId(req));
        success(res, { message: 'Current verification status retrieved', data: result });
    }

    public async grantMerchantDisclosure(req: AuthRequest, res: Response): Promise<void> {
        const input = disclosureSchema.parse(req.body);
        const result = await this.flow.grantDisclosure(authenticatedUserId(req), input);
        success(res, { message: 'Merchant disclosure consent recorded', data: result }, 201);
    }

    public async withdrawConsent(req: AuthRequest, res: Response): Promise<void> {
        const grantId = consentIdSchema.parse(req.params.id);
        await this.flow.withdrawConsent(authenticatedUserId(req), grantId);
        success(res, { message: 'Verification consent withdrawn', data: { grantId } });
    }

    public async registrationUnavailable(): Promise<void> {
        throw new ServiceUnavailableError('Registration verification is temporarily unavailable pending the configured institution adapter.');
    }

    public async retiredLegacyRoute(): Promise<void> {
        throw new AppError(
            'This verification route has been retired. Upgrade to the authenticated verification flow.',
            410,
            'VERIFICATION_ROUTE_RETIRED',
        );
    }

    public async widgetUnavailable(): Promise<void> {
        throw new ServiceUnavailableError('Merchant verification tokens are temporarily unavailable pending the merchant assertion flow.');
    }
}
