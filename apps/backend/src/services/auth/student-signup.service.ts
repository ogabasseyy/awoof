import type { Pool, PoolClient } from 'pg';
import {
    BadRequestError,
    ConflictError,
    RateLimitError,
    ServiceUnavailableError,
    UnauthorizedError,
} from '../../common/errors/AppError.js';
import { passwordService } from './password.service.js';
import { consumeChallenge, requestChallenge } from '../verification/challenge.service.js';
import { grantVerificationProcessing } from '../verification/eligibility-consent.service.js';
import { recordEmailAssurance, recordMailboxProof } from '../verification/eligibility-evidence.service.js';
import { getInstitutionPolicy, normalizeMailbox } from '../verification/eligibility-policy.service.js';
import type { EligibilityResult, SignupChallengeBindings } from '../verification/eligibility.types.js';
import { STUDENT_TERMS_VERSION, VERIFICATION_NOTICE_VERSION } from '../verification/verification-notices.js';

export type StudentSignupIdentity = {
    email: string;
    name: string;
    universityId: string;
    matricNumber: string | null;
    verificationConsent: true;
    noticeVersion: string;
    ageAttested: true;
    termsAccepted: true;
    termsVersion: string;
};

/**
 * Pre-cutover confirm identity: Terms 1.0 without an age declaration.
 * Valid only against challenges issued before the rollout (whose stored
 * bindings carry no attestation); the live request path never produces it.
 */
export type LegacyStudentSignupIdentity = Omit<StudentSignupIdentity, 'ageAttested' | 'termsVersion'> & {
    ageAttested: false;
    termsVersion: '1.0';
};

export const LEGACY_SIGNUP_TERMS_VERSION = '1.0';

export type StudentSignupInput = Omit<StudentSignupIdentity, 'verificationConsent' | 'ageAttested' | 'termsAccepted'> & {
    verificationConsent: boolean;
    ageAttested: boolean;
    termsAccepted: boolean;
    otp?: string;
};

export type StudentSignupConfirmationInput = StudentSignupInput & {
    challengeId: string;
    password: string;
};

type PoolLike = Pick<Pool, 'connect'>;

type StudentSignupDependencies = {
    pool: PoolLike;
    isEmailConfigured: () => boolean;
    deliverOtp: (email: string, code: string, name: string) => Promise<{ success: boolean }>;
};

export type StudentSignupRequestResult = {
    email: string;
    challengeId: string;
    expiresAt: Date;
    resendAvailableAt: Date;
};

export type StudentSignupCompletion = {
    user: { id: string; email: string; role: 'student' };
    eligibility: EligibilityResult;
    expectedPasswordHash: string;
};

export class StudentSignupRateLimitError extends RateLimitError {
    public readonly retryAt: Date;

    constructor(message: string, retryAt: Date) {
        super(message, { retryAt: retryAt.toISOString() });
        this.retryAt = retryAt;
    }
}

export function normalizeStudentSignupRequest(input: StudentSignupInput): StudentSignupIdentity {
    const email = normalizeMailbox(input.email);
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const matricNumber = input.matricNumber === null || input.matricNumber === undefined
        ? null
        : typeof input.matricNumber === 'string' && input.matricNumber.trim() !== ''
            ? input.matricNumber.trim()
            : null;
    if (name.length < 2 || name.length > 255) throw new BadRequestError('Student name must be between 2 and 255 characters');
    if (matricNumber !== null && matricNumber.length > 100) throw new BadRequestError('Matric number must be at most 100 characters');
    if (input.verificationConsent !== true || input.noticeVersion !== VERIFICATION_NOTICE_VERSION) {
        throw new BadRequestError('Current verification processing consent required');
    }
    if (input.ageAttested !== true) {
        throw new BadRequestError('You must confirm you are 18 or older to create an account');
    }
    if (input.termsAccepted !== true || input.termsVersion !== STUDENT_TERMS_VERSION) {
        throw new BadRequestError('Current student terms acceptance required');
    }
    if (input.otp !== undefined && !/^\d{6}$/.test(input.otp)) {
        throw new BadRequestError('Signup OTP must be six digits');
    }
    return {
        email,
        name,
        universityId: input.universityId,
        matricNumber,
        verificationConsent: true,
        noticeVersion: input.noticeVersion,
        ageAttested: true,
        termsAccepted: true,
        termsVersion: input.termsVersion,
    };
}

/**
 * Validates a pre-cutover confirm payload: the exact legacy shape (Terms 1.0,
 * no age declaration) with otherwise current identity and consent checks.
 * Mixed shapes fail closed so a legacy confirm can never mint or match a
 * current-contract challenge.
 */
export function normalizeLegacySignupConfirmation(input: StudentSignupInput): LegacyStudentSignupIdentity {
    const email = normalizeMailbox(input.email);
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const matricNumber = input.matricNumber === null || input.matricNumber === undefined
        ? null
        : typeof input.matricNumber === 'string' && input.matricNumber.trim() !== ''
            ? input.matricNumber.trim()
            : null;
    if (name.length < 2 || name.length > 255) throw new BadRequestError('Student name must be between 2 and 255 characters');
    if (matricNumber !== null && matricNumber.length > 100) throw new BadRequestError('Matric number must be at most 100 characters');
    if (input.verificationConsent !== true || input.noticeVersion !== VERIFICATION_NOTICE_VERSION) {
        throw new BadRequestError('Current verification processing consent required');
    }
    if (input.ageAttested !== false) {
        throw new BadRequestError('Legacy signup confirmation must not carry an age declaration');
    }
    if (input.termsAccepted !== true || input.termsVersion !== LEGACY_SIGNUP_TERMS_VERSION) {
        throw new BadRequestError('Legacy signup confirmation requires Terms version 1.0');
    }
    if (input.otp !== undefined && !/^\d{6}$/.test(input.otp)) {
        throw new BadRequestError('Signup OTP must be six digits');
    }
    return {
        email,
        name,
        universityId: input.universityId,
        matricNumber,
        verificationConsent: true,
        noticeVersion: input.noticeVersion,
        ageAttested: false,
        termsAccepted: true,
        termsVersion: LEGACY_SIGNUP_TERMS_VERSION,
    };
}

async function inTransaction<T>(pool: PoolLike, operation: (tx: PoolClient) => Promise<T>): Promise<T> {
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

function mailboxDomain(email: string): string {
    return email.slice(email.lastIndexOf('@') + 1);
}

function assertPolicyAllowsSignup(
    policy: Awaited<ReturnType<typeof getInstitutionPolicy>>,
    email: string,
): void {
    if (!policy.isActive || !policy.domains.includes(mailboxDomain(email))) {
        throw new BadRequestError('Student email domain is not supported for this institution');
    }
}

async function assertNoExistingIdentity(tx: PoolClient, email: string): Promise<void> {
    const existing = await tx.query(
        `SELECT id FROM users
         WHERE lower(btrim(email)) = $1
         LIMIT 1`,
        [email],
    );
    if (existing.rowCount !== 0) throw new ConflictError('User with this email already exists');
}

function sameSignupBindings(
    value: unknown,
    identity: StudentSignupIdentity | LegacyStudentSignupIdentity,
    policyVersion: number,
): value is SignupChallengeBindings {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const bindings = value as Partial<SignupChallengeBindings>;
    // Pre-cutover bindings carry no attestation key; a missing key matches
    // only the legacy identity, so contracts cannot be mixed across stages.
    return bindings.email === identity.email
        && bindings.name === identity.name
        && bindings.universityId === identity.universityId
        && bindings.matricNumber === identity.matricNumber
        && bindings.policyVersion === policyVersion
        && bindings.verificationConsent === true
        && bindings.noticeVersion === identity.noticeVersion
        && (bindings.ageAttested ?? false) === identity.ageAttested
        && bindings.termsAccepted === true
        && bindings.termsVersion === identity.termsVersion;
}

function passwordHashFor(password: string): Promise<string> {
    const validation = passwordService.validatePassword(password);
    if (!validation.valid) throw new BadRequestError(validation.errors.join(', '));
    return passwordService.hashPassword(password);
}

export function createStudentSignupService(dependencies: StudentSignupDependencies) {
    async function request(input: StudentSignupInput): Promise<StudentSignupRequestResult> {
        const identity = normalizeStudentSignupRequest(input);
        if (!dependencies.isEmailConfigured()) {
            throw new ServiceUnavailableError('Signup email delivery is temporarily unavailable. Please try again later.');
        }

        const challenge = await inTransaction(dependencies.pool, async (tx) => {
            const policy = await getInstitutionPolicy(tx, identity.universityId);
            assertPolicyAllowsSignup(policy, identity.email);
            await assertNoExistingIdentity(tx, identity.email);
            const requested = await requestChallenge(tx, {
                purpose: 'student_signup',
                subjectKey: identity.email,
                bindings: {
                    email: identity.email,
                    name: identity.name,
                    universityId: identity.universityId,
                    matricNumber: identity.matricNumber,
                    policyVersion: policy.policyVersion,
                    verificationConsent: true,
                    noticeVersion: identity.noticeVersion,
                    ageAttested: true,
                    termsAccepted: true,
                    termsVersion: identity.termsVersion,
                } satisfies SignupChallengeBindings,
            });
            if (requested.status !== 'issued') return requested;
            const budget = await tx.query<{ resend_available_at: Date }>(
                `SELECT resend_available_at
                 FROM verification_challenge_budgets
                 WHERE purpose = 'student_signup' AND current_challenge_id = $1`,
                [requested.challengeId],
            );
            const resendAvailableAt = budget.rows[0]?.resend_available_at;
            if (!resendAvailableAt) throw new Error('Signup challenge resend time was not returned');
            return { ...requested, resendAvailableAt };
        });
        if (challenge.status !== 'issued') {
            throw new StudentSignupRateLimitError(
                challenge.status === 'locked'
                    ? 'Too many signup attempts. Please try again later.'
                    : 'Please wait before requesting another signup code.',
                challenge.retryAt,
            );
        }

        try {
            const delivered = await dependencies.deliverOtp(identity.email, challenge.code, identity.name);
            if (!delivered.success) throw new Error('delivery rejected');
        } catch {
            // The committed challenge and its resend cooldown intentionally remain
            // in place after a transport failure; a later request can recover.
            throw new ServiceUnavailableError('We could not deliver a signup code. Please wait before trying again.');
        }
        return {
            email: identity.email,
            challengeId: challenge.challengeId,
            expiresAt: challenge.expiresAt,
            resendAvailableAt: challenge.resendAvailableAt,
        };
    }

    async function confirm(input: StudentSignupConfirmationInput): Promise<StudentSignupCompletion> {
        // A legacy payload completes only a pre-cutover challenge; the stored
        // bindings check below rejects it against any attested challenge, and
        // the request path never issues unattested challenges, so this grace
        // self-expires with the ten-minute challenge TTL.
        const legacy = input.ageAttested !== true || input.termsVersion !== STUDENT_TERMS_VERSION;
        const identity = legacy ? normalizeLegacySignupConfirmation(input) : normalizeStudentSignupRequest(input);
        const outcome = await inTransaction(dependencies.pool, async (tx) => {
            // This locks the canonical institution before the signup budget. The
            // account is deliberately absent until a verified proof is consumed.
            const policy = await getInstitutionPolicy(tx, identity.universityId);
            assertPolicyAllowsSignup(policy, identity.email);
            await assertNoExistingIdentity(tx, identity.email);
            const consumed = await consumeChallenge(tx, {
                purpose: 'student_signup',
                subjectKey: identity.email,
                challengeId: input.challengeId,
                code: input.otp ?? '',
            });
            if (consumed.status !== 'verified') return consumed;
            if (!sameSignupBindings(consumed.bindings, identity, policy.policyVersion)) {
                throw new BadRequestError('Signup details do not match the requested proof');
            }

            const expectedPasswordHash = await passwordHashFor(input.password);
            const university = await tx.query<{ name: string }>(
                `SELECT name FROM universities WHERE id = $1`,
                [identity.universityId],
            );
            const universityName = university.rows[0]?.name;
            if (!universityName) throw new BadRequestError('Institution not found');
            const user = (await tx.query<{ id: string; email: string; role: 'student' }>(
                `INSERT INTO users (email, password_hash, role)
                 VALUES ($1, $2, 'student')
                 RETURNING id, lower(btrim(email)) AS email, role`,
                [identity.email, expectedPasswordHash],
            )).rows[0];
            if (!user) throw new Error('Student account was not returned');
            await tx.query(
                `INSERT INTO students (user_id, name, university, university_id, registration_number, status)
                 VALUES ($1, $2, $3, $4, $5, 'active')`,
                [user.id, identity.name, universityName, identity.universityId, identity.matricNumber],
            );
            const processingGrantId = await grantVerificationProcessing(tx, user.id, identity.universityId, {
                accepted: true,
                noticeVersion: identity.noticeVersion,
            });
            await tx.query(
                `INSERT INTO terms_acceptances (user_id, kind, terms_version, age_attested)
                 VALUES ($1, 'student_terms', $2, $3)`,
                [user.id, identity.termsVersion, identity.ageAttested],
            );
            await recordMailboxProof(tx, user.id, consumed.challengeId);
            const eligibility = await recordEmailAssurance(tx, user.id, {
                challengeId: consumed.challengeId,
                processingGrantId,
            });
            return { status: 'completed' as const, user, eligibility, expectedPasswordHash };
        });
        if ('user' in outcome) {
            return {
                user: outcome.user,
                eligibility: outcome.eligibility,
                expectedPasswordHash: outcome.expectedPasswordHash,
            };
        }
        if (outcome.status === 'invalid') {
            throw new UnauthorizedError('Invalid or expired signup code.');
        } else if (outcome.status === 'expired') {
            throw new BadRequestError('Signup code has expired. Please request a new one.');
        } else {
            throw new UnauthorizedError('Signup code is unavailable. Please request a new one later.');
        }
    }

    return { request, confirm };
}

export type StudentSignupService = ReturnType<typeof createStudentSignupService>;
