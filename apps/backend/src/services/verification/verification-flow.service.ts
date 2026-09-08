import type { Pool, PoolClient } from 'pg';
import {
    BadRequestError,
    NotFoundError,
    RateLimitError,
    ServiceUnavailableError,
} from '../../common/errors/AppError.js';
import { db } from '../../config/database.js';
import { sendEmail, isEmailConfigured } from '../email/email.service.js';
import { consumeChallenge, challengeSubjectDigest, requestChallenge } from './challenge.service.js';
import {
    grantMerchantDisclosure,
    grantVerificationProcessing,
    withdrawConsent as withdrawEligibilityConsent,
} from './eligibility-consent.service.js';
import { lockStudentContext, selectStudentInstitution } from './eligibility-context.service.js';
import {
    applyEnrollmentDecision,
    beginEnrollmentCheck,
    recordEmailAssurance,
} from './eligibility-evidence.service.js';
import { getInstitutionPolicy } from './eligibility-policy.service.js';
import { getEffectiveEligibility } from './eligibility-read.service.js';
import type { EligibilityResult, StudentContext, StudentEmailChallengeBindings } from './eligibility.types.js';
import {
    parseConfiguredEnrollmentAdapter,
    verifyConfiguredEnrollment,
    type EnrollmentTransport,
    type RegistrationNormalization,
} from './registration-lookup.service.js';
import {
    MERCHANT_DISCLOSURE_NOTICE_TEXT,
    MERCHANT_DISCLOSURE_NOTICE_VERSION,
    VERIFICATION_NOTICE_TEXT,
    VERIFICATION_NOTICE_VERSION,
} from './verification-notices.js';

type PoolLike = Pick<Pool, 'connect'>;

export type VerificationFlowDependencies = {
    pool: PoolLike;
    isEmailConfigured: () => boolean;
    deliverOtp: (email: string, code: string) => Promise<{ success: boolean }>;
    enrollmentTransport?: EnrollmentTransport;
};

type InitiateInput = {
    universityId: string;
    accepted: true;
    noticeVersion: string;
};

type RequestEmailInput = {
    processingGrantId: string;
};

type ConfirmEmailInput = {
    challengeId: string;
    otp: string;
};

type RegistrationInput = {
    registrationNumber: string;
    processingGrantId: string;
};

type DisclosureInput = {
    vendorId: string;
    origin: string;
    purpose: string;
    accepted: true;
    noticeVersion: string;
};

type PoolTransactionResult<T> = T;

export type VerificationNotices = {
    verification: { version: string; text: string };
    merchantDisclosure: { version: string; text: string };
};

export type VerificationInitiation = {
    email: string;
    universityId: string;
    processingGrantId: string;
    eligibility: EligibilityResult;
    notices: VerificationNotices;
};

export type VerificationEmailRequest = {
    challengeId: string;
    expiresAt: Date;
    resendAvailableAt: Date;
};

export type VerificationStatus = {
    mailboxConfirmed: boolean;
    email: string;
    universityId: string | null;
    eligibility: EligibilityResult;
    notices: VerificationNotices;
    guidance?: 'incomplete_profile';
};

export type RegistrationVerification = {
    eligibility: EligibilityResult;
    reason?: 'provider_unknown' | 'provider_unavailable';
};

export class VerificationFlowRateLimitError extends RateLimitError {
    public readonly retryAt: Date;

    constructor(message: string, retryAt: Date) {
        super(message, { retryAt: retryAt.toISOString() });
        this.retryAt = retryAt;
    }
}

function notices(): VerificationNotices {
    return {
        verification: { version: VERIFICATION_NOTICE_VERSION, text: VERIFICATION_NOTICE_TEXT },
        merchantDisclosure: { version: MERCHANT_DISCLOSURE_NOTICE_VERSION, text: MERCHANT_DISCLOSURE_NOTICE_TEXT },
    };
}

async function inTransaction<T>(pool: PoolLike, operation: (tx: PoolClient) => Promise<T>): Promise<PoolTransactionResult<T>> {
    const tx = await pool.connect();
    let active = false;
    try {
        await tx.query('BEGIN');
        active = true;
        const result = await operation(tx);
        await tx.query('COMMIT');
        return result;
    } catch (error) {
        if (active) await tx.query('ROLLBACK').catch(() => undefined);
        throw error;
    } finally {
        tx.release();
    }
}

function assertActiveContext(context: StudentContext): void {
    if (!context.active) throw new BadRequestError('Active student context required');
}

async function assertLiveStudentActor(tx: PoolClient, userId: string): Promise<void> {
    const account = await tx.query<{ role: string; deleted_at: Date | null }>(
        `SELECT role, deleted_at
         FROM users
         WHERE id = $1
         FOR UPDATE`,
        [userId],
    );
    const user = account.rows[0];
    if (!user || user.deleted_at !== null || user.role !== 'student') {
        throw new BadRequestError('Active student context required');
    }
}

function mailboxDomain(email: string): string {
    return email.slice(email.lastIndexOf('@') + 1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameStudentEmailBindings(
    value: unknown,
    context: StudentContext,
    processingGrantId: string,
): value is StudentEmailChallengeBindings {
    if (!isRecord(value)) return false;
    const bindings = value as Partial<StudentEmailChallengeBindings>;
    return bindings.userId === context.userId
        && bindings.studentId === context.studentId
        && bindings.email === context.email
        && bindings.universityId === context.universityId
        && bindings.identityVersion === context.identityVersion
        && bindings.policyVersion === context.policyVersion
        && bindings.processingGrantId === processingGrantId
        && bindings.noticeVersion === VERIFICATION_NOTICE_VERSION;
}

async function assertApprovedCurrentMailbox(tx: PoolClient, context: StudentContext): Promise<void> {
    const policy = await getInstitutionPolicy(tx, context.universityId);
    if (!context.active || !policy.isActive || !policy.domains.includes(mailboxDomain(context.email))) {
        throw new BadRequestError('Student email domain is not supported for this institution');
    }
}

async function lockStateThenCurrentGrant(
    tx: PoolClient,
    context: StudentContext,
    processingGrantId: string,
): Promise<void> {
    // The state read deliberately precedes the processing-consent lock. The
    // challenge service is only called after this common prefix is held.
    await tx.query(
        `SELECT student_id
         FROM student_eligibility_state
         WHERE student_id = $1 AND university_id = $2
         FOR UPDATE`,
        [context.studentId, context.universityId],
    );
    const grant = await tx.query(
        `SELECT id
         FROM verification_consents
         WHERE id = $1
           AND user_id = $2
           AND university_id = $3
           AND kind = 'processing'
           AND accepted
           AND withdrawn_at IS NULL
           AND notice_version = $4
         FOR UPDATE`,
        [processingGrantId, context.userId, context.universityId, VERIFICATION_NOTICE_VERSION],
    );
    if (grant.rowCount !== 1) throw new BadRequestError('Current processing consent required');
}

async function resendAvailableAt(tx: PoolClient, challengeId: string): Promise<Date> {
    const result = await tx.query<{ resend_available_at: Date }>(
        `SELECT resend_available_at
         FROM verification_challenge_budgets
         WHERE purpose = 'student_email' AND current_challenge_id = $1`,
        [challengeId],
    );
    const retryAt = result.rows[0]?.resend_available_at;
    if (!retryAt) throw new Error('Verification challenge resend time was not returned');
    return retryAt;
}

async function lockedRetryAt(tx: PoolClient, userId: string): Promise<Date> {
    const result = await tx.query<{ window_started_at: Date }>(
        `SELECT window_started_at
         FROM verification_challenge_budgets
         WHERE purpose = 'student_email' AND subject_digest = $1
         FOR UPDATE`,
        [challengeSubjectDigest('student_email', userId)],
    );
    const startedAt = result.rows[0]?.window_started_at;
    if (!startedAt) throw new Error('Verification challenge budget was not returned');
    return new Date(startedAt.getTime() + 10 * 60 * 1000);
}

async function loadConfiguredEnrollmentAdapter(tx: PoolClient, universityId: string) {
    const methods = await tx.query<{
        is_active: unknown;
        api_endpoint: unknown;
        api_config: unknown;
    }>(
        `SELECT is_active, api_endpoint, api_config
         FROM university_verification_methods
         WHERE university_id = $1
           AND method_type = 'registration'`,
        [universityId],
    );
    if (methods.rows.length !== 1) return null;
    const method = methods.rows[0]!;
    return parseConfiguredEnrollmentAdapter({
        isActive: method.is_active,
        apiEndpoint: method.api_endpoint,
        apiConfig: method.api_config,
    });
}

async function discoverProcessingGrant(
    pool: PoolLike,
    userId: string,
    challengeId: string,
): Promise<string> {
    const client = await pool.connect();
    try {
        // This intentionally has no FOR UPDATE clause. It only discovers the
        // persisted grant identifier; the transaction below rechecks every
        // binding after the common context/state/grant locks are acquired.
        const result = await client.query<{ bindings: unknown }>(
            `SELECT bindings
             FROM verification_challenges
             WHERE id = $1
               AND purpose = 'student_email'
               AND subject_digest = $2`,
            [challengeId, challengeSubjectDigest('student_email', userId)],
        );
        const bindings = result.rows[0]?.bindings;
        if (!isRecord(bindings) || typeof bindings.processingGrantId !== 'string') {
            throw new BadRequestError('Verification challenge is not available for this account');
        }
        return bindings.processingGrantId;
    } finally {
        client.release();
    }
}

function productionOtpEmail(email: string, code: string): Promise<{ success: boolean }> {
    return sendEmail(
        email,
        'Confirm your Awoof student email',
        `<p>Use this code to confirm your current school email:</p><p><strong>${code}</strong></p><p>This does not create a new account.</p>`,
    );
}

export function createVerificationFlowService(dependencies: VerificationFlowDependencies) {
    async function initiate(userId: string, input: InitiateInput): Promise<VerificationInitiation> {
        return inTransaction(dependencies.pool, async (tx) => {
            await assertLiveStudentActor(tx, userId);
            const context = await selectStudentInstitution(tx, userId, input.universityId);
            assertActiveContext(context);
            // Read current eligibility before creating a new processing grant so
            // state locks remain ahead of consent locks in this transaction.
            const eligibility = await getEffectiveEligibility(tx, userId);
            const processingGrantId = await grantVerificationProcessing(tx, userId, context.universityId, {
                accepted: input.accepted,
                noticeVersion: input.noticeVersion,
            });
            return {
                email: context.email,
                universityId: context.universityId,
                processingGrantId,
                eligibility,
                notices: notices(),
            };
        });
    }

    async function requestEmail(userId: string, input: RequestEmailInput): Promise<VerificationEmailRequest> {
        const challenge = await inTransaction(dependencies.pool, async (tx) => {
            await assertLiveStudentActor(tx, userId);
            const context = await lockStudentContext(tx, userId);
            assertActiveContext(context);
            await assertApprovedCurrentMailbox(tx, context);
            await lockStateThenCurrentGrant(tx, context, input.processingGrantId);
            const issued = await requestChallenge(tx, {
                purpose: 'student_email',
                subjectKey: userId,
                bindings: {
                    userId: context.userId,
                    studentId: context.studentId,
                    email: context.email,
                    universityId: context.universityId,
                    identityVersion: context.identityVersion,
                    policyVersion: context.policyVersion,
                    processingGrantId: input.processingGrantId,
                    noticeVersion: VERIFICATION_NOTICE_VERSION,
                } satisfies StudentEmailChallengeBindings,
            });
            if (issued.status !== 'issued') return issued;
            return { ...issued, resendAvailableAt: await resendAvailableAt(tx, issued.challengeId), email: context.email };
        });
        if (challenge.status !== 'issued') {
            throw new VerificationFlowRateLimitError(
                challenge.status === 'locked'
                    ? 'Too many verification attempts. Please try again later.'
                    : 'Please wait before requesting another verification code.',
                challenge.retryAt,
            );
        }
        try {
            if (!dependencies.isEmailConfigured()) throw new Error('email not configured');
            const delivered = await dependencies.deliverOtp(challenge.email, challenge.code);
            if (!delivered.success) throw new Error('delivery rejected');
        } catch {
            // The issued challenge and its budget were committed before any
            // transport call; a delivery failure must not restore capacity.
            throw new ServiceUnavailableError('We could not deliver a verification code. Please wait before trying again.');
        }
        return {
            challengeId: challenge.challengeId,
            expiresAt: challenge.expiresAt,
            resendAvailableAt: challenge.resendAvailableAt,
        };
    }

    async function confirmEmail(userId: string, input: ConfirmEmailInput): Promise<EligibilityResult> {
        const processingGrantId = await discoverProcessingGrant(dependencies.pool, userId, input.challengeId);
        const outcome = await inTransaction(dependencies.pool, async (tx) => {
            await assertLiveStudentActor(tx, userId);
            const context = await lockStudentContext(tx, userId);
            assertActiveContext(context);
            await assertApprovedCurrentMailbox(tx, context);
            await lockStateThenCurrentGrant(tx, context, processingGrantId);
            const consumed = await consumeChallenge(tx, {
                purpose: 'student_email',
                subjectKey: userId,
                challengeId: input.challengeId,
                code: input.otp,
            });
            if (consumed.status !== 'verified') {
                if (consumed.status === 'locked') {
                    return { status: 'locked' as const, retryAt: await lockedRetryAt(tx, userId) };
                }
                return { status: consumed.status };
            }
            if (!sameStudentEmailBindings(consumed.bindings, context, processingGrantId)) {
                throw new BadRequestError('Verification challenge bindings are stale');
            }
            return {
                status: 'verified' as const,
                eligibility: await recordEmailAssurance(tx, userId, {
                    challengeId: consumed.challengeId,
                    processingGrantId,
                }),
            };
        });
        if (outcome.status === 'verified') return outcome.eligibility;
        if (outcome.status === 'locked') {
            throw new VerificationFlowRateLimitError('Too many verification attempts. Please try again later.', outcome.retryAt);
        }
        if (outcome.status === 'expired') {
            throw new BadRequestError('Verification code has expired. Please request a new one.');
        }
        // The caller is already authenticated. Returning 401 here would make
        // the shared authenticated client refresh and retry, consuming a
        // second OTP guess; an invalid code is a request error, not session
        // invalidation.
        throw new BadRequestError('Invalid verification code.');
    }

    async function verifyRegistration(userId: string, input: RegistrationInput): Promise<RegistrationVerification> {
        let captured: {
            snapshot: Awaited<ReturnType<typeof beginEnrollmentCheck>>;
            adapter: NonNullable<Awaited<ReturnType<typeof loadConfiguredEnrollmentAdapter>>>;
            normalization: RegistrationNormalization;
        };
        try {
            captured = await inTransaction(dependencies.pool, async (tx) => {
                await assertLiveStudentActor(tx, userId);
                const snapshot = await beginEnrollmentCheck(tx, userId, input.processingGrantId);
                // This read intentionally has no FOR UPDATE clause. The snapshot
                // already holds the institution lock; method changes advance its
                // policy generation rather than creating a method-lock cycle.
                const adapter = await loadConfiguredEnrollmentAdapter(tx, snapshot.universityId);
                const policy = await getInstitutionPolicy(tx, snapshot.universityId);
                if (!adapter || policy.registrationNormalization === null) {
                    throw new ServiceUnavailableError('Registration verification is unavailable for this institution.');
                }
                return { snapshot, adapter, normalization: policy.registrationNormalization };
            });
        } catch (error) {
            if (error instanceof BadRequestError && error.message === 'Enrollment method unavailable') {
                throw new ServiceUnavailableError('Registration verification is unavailable for this institution.');
            }
            throw error;
        }

        // Provider transport is deliberately outside all database locks. Both
        // the snapshot and the requested identifier are immutable inputs here.
        const lookup = await verifyConfiguredEnrollment(captured.adapter, {
            email: captured.snapshot.email,
            registrationNumber: input.registrationNumber,
            normalization: captured.normalization,
        }, dependencies.enrollmentTransport);
        const eligibility = await inTransaction(dependencies.pool, (tx) => (
            applyEnrollmentDecision(tx, captured.snapshot, lookup.decision)
        ));
        return lookup.reason === undefined ? { eligibility } : { eligibility, reason: lookup.reason };
    }

    async function status(userId: string): Promise<VerificationStatus> {
        return inTransaction(dependencies.pool, async (tx) => {
            try {
                const context = await lockStudentContext(tx, userId);
                // Status is a non-mutating self-read. A live student whose
                // profile or institution became inactive needs the authority's
                // factual inactive result in order to recover or withdraw
                // consent; only a deleted or non-student current account is
                // denied below.
                if (!context.active) {
                    const account = await tx.query<{ role: string; deleted_at: Date | null }>(
                        `SELECT role, deleted_at
                         FROM users
                         WHERE id = $1
                         FOR UPDATE`,
                        [userId],
                    );
                    const user = account.rows[0];
                    if (!user || user.deleted_at !== null || user.role !== 'student') {
                        throw new BadRequestError('Active student context required');
                    }
                }
                const proof = await tx.query(
                    'SELECT 1 FROM user_email_proofs WHERE user_id = $1 AND email = $2 LIMIT 1',
                    [userId, context.email]);
                return {
                    mailboxConfirmed: proof.rowCount === 1,
                    email: context.email,
                    universityId: context.universityId,
                    eligibility: await getEffectiveEligibility(tx, userId),
                    notices: notices(),
                };
            } catch (error) {
                if (!(error instanceof NotFoundError)) throw error;
                const account = await tx.query<{ email: string; role: string; deleted_at: Date | null }>(
                    `SELECT lower(btrim(email)) AS email, role, deleted_at
                     FROM users
                     WHERE id = $1
                     FOR UPDATE`,
                    [userId],
                );
                const user = account.rows[0];
                if (!user || user.deleted_at !== null || user.role !== 'student') {
                    throw new BadRequestError('Active student context required');
                }
                return {
                    mailboxConfirmed: false,
                    email: user.email,
                    universityId: null,
                    eligibility: { eligible: false, reason: 'unverified' },
                    notices: notices(),
                    guidance: 'incomplete_profile',
                };
            }
        });
    }

    async function grantDisclosure(userId: string, input: DisclosureInput): Promise<{ grantId: string }> {
        return inTransaction(dependencies.pool, async (tx) => ({
            grantId: await grantMerchantDisclosure(tx, userId, input),
        }));
    }

    async function withdrawConsent(userId: string, grantId: string): Promise<void> {
        await inTransaction(dependencies.pool, (tx) => withdrawEligibilityConsent(tx, userId, grantId));
    }

    return { initiate, requestEmail, confirmEmail, verifyRegistration, status, grantDisclosure, withdrawConsent };
}

export type VerificationFlowService = ReturnType<typeof createVerificationFlowService>;

export const verificationFlowService = createVerificationFlowService({
    // Do not initialize the application pool merely by mounting the router;
    // synthetic HTTP tests inject their own flow and production opens the pool
    // only when an authenticated flow operation is requested.
    pool: { connect: () => db.getPool().connect() },
    isEmailConfigured,
    deliverOtp: productionOtpEmail,
});
