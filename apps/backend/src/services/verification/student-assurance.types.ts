export type StudentStatus = 'pending' | 'verified' | 'expired' | 'denied' | 'revoked' | 'inactive';

export type SchoolAccountStatus = 'unverified' | 'verified' | 'expired';

export type SchoolAccountMethod = 'email_otp' | 'google_workspace' | 'microsoft_school' | null;

export type EnrollmentMethod = 'registration' | 'microsoft_graph' | null;

export type StudentAssuranceReason =
    | 'awaiting_enrollment'
    | 'evidence_expired'
    | 'enrollment_denied'
    | 'consent_withdrawn'
    | 'identity_changed'
    | 'policy_changed'
    | 'inactive'
    | 'provider_unavailable'
    | null;

export type StudentAssurance = {
    schoolAccountStatus: SchoolAccountStatus;
    schoolAccountMethod: SchoolAccountMethod;
    schoolAccountValidUntil: string | null;
    studentStatus: StudentStatus;
    enrollmentMethod: EnrollmentMethod;
    studentValidUntil: string | null;
    reason: StudentAssuranceReason;
};
