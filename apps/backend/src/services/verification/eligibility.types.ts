export type AssuranceMethod = 'student_email' | 'enrollment';

export type EligibilityResult =
    | {
        eligible: false;
        reason: 'unverified' | 'expired' | 'inactive' | 'policy_changed' | 'identity_changed' | 'consent_required' | 'enrollment_denied';
    }
    | {
        eligible: true;
        studentId: string;
        universityId: string;
        evidenceId: string;
        processingGrantId: string;
        method: AssuranceMethod;
        verifiedAt: Date;
        expiresAt: Date;
    };

export type InstitutionPolicyInput = {
    domains: string[];
    emailEvidenceValidityDays: number;
    enrollmentValidityDays: number;
    registrationNormalization: 'exact' | 'trim_upper' | null;
    isActive: boolean;
};

export type StudentContext = {
    userId: string;
    studentId: string;
    email: string;
    universityId: string;
    identityVersion: number;
    policyVersion: number;
    active: boolean;
};

export type EnrollmentSnapshot = StudentContext & {
    requestGeneration: number;
    processingGrantId: string;
    emailProofId: string;
};

export type EnrollmentDecision =
    | { outcome: 'unknown' }
    | { outcome: 'verified'; email: string; registrationNumber: string; validUntil: Date; source: string }
    | { outcome: 'denied'; email: string; source: string };

export const ENROLLMENT_SOURCE = 'institution-registration:v1';

export type StudentEmailChallengeBindings = {
    userId: string;
    studentId: string;
    email: string;
    universityId: string;
    identityVersion: number;
    policyVersion: number;
    processingGrantId: string;
    noticeVersion: string;
};

export type SignupChallengeBindings = {
    email: string;
    name: string;
    universityId: string;
    matricNumber: string | null;
    policyVersion: number;
    verificationConsent: true;
    noticeVersion: string;
};

export type AccountEmailChallengeBindings = {
    userId: string;
    email: string;
};
