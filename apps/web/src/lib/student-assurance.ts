/**
 * Browser parser for the server's StudentAssurance projection. School-account
 * assurance and current-enrollment eligibility are independent checks: a
 * verified school mailbox never implies student benefits. The server remains
 * authoritative; this only validates display data.
 */

export type StudentAssurance = {
    schoolAccountStatus: 'unverified' | 'verified' | 'expired';
    schoolAccountMethod: 'email_otp' | 'google_workspace' | 'microsoft_school' | null;
    schoolAccountValidUntil: string | null;
    studentStatus: 'pending' | 'verified' | 'expired' | 'denied' | 'revoked' | 'inactive';
    enrollmentMethod: 'registration' | 'microsoft_graph' | null;
    studentValidUntil: string | null;
    reason: 'awaiting_enrollment' | 'evidence_expired' | 'enrollment_denied'
        | 'consent_withdrawn' | 'identity_changed' | 'policy_changed'
        | 'inactive' | 'provider_unavailable' | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isInstant(value: unknown): value is string {
    return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validUntil(value: unknown): string | null | undefined {
    if (value === null) return null;
    return isInstant(value) ? value : undefined;
}

/** Strictly validate server assurance for display; null means unusable. */
export function parseStudentAssurance(value: unknown): StudentAssurance | null {
    if (!isRecord(value)) return null;
    if (value.schoolAccountStatus !== 'unverified'
        && value.schoolAccountStatus !== 'verified'
        && value.schoolAccountStatus !== 'expired') return null;
    if (value.schoolAccountMethod !== null
        && value.schoolAccountMethod !== 'email_otp'
        && value.schoolAccountMethod !== 'google_workspace'
        && value.schoolAccountMethod !== 'microsoft_school') return null;
    if (value.studentStatus !== 'pending'
        && value.studentStatus !== 'verified'
        && value.studentStatus !== 'expired'
        && value.studentStatus !== 'denied'
        && value.studentStatus !== 'revoked'
        && value.studentStatus !== 'inactive') return null;
    if (value.enrollmentMethod !== null
        && value.enrollmentMethod !== 'registration'
        && value.enrollmentMethod !== 'microsoft_graph') return null;
    if (value.reason !== null
        && value.reason !== 'awaiting_enrollment'
        && value.reason !== 'evidence_expired'
        && value.reason !== 'enrollment_denied'
        && value.reason !== 'consent_withdrawn'
        && value.reason !== 'identity_changed'
        && value.reason !== 'policy_changed'
        && value.reason !== 'inactive'
        && value.reason !== 'provider_unavailable') return null;
    const schoolAccountValidUntil = validUntil(value.schoolAccountValidUntil);
    const studentValidUntil = validUntil(value.studentValidUntil);
    if (schoolAccountValidUntil === undefined || studentValidUntil === undefined) return null;
    return {
        schoolAccountStatus: value.schoolAccountStatus,
        schoolAccountMethod: value.schoolAccountMethod,
        schoolAccountValidUntil,
        studentStatus: value.studentStatus,
        enrollmentMethod: value.enrollmentMethod,
        studentValidUntil,
        reason: value.reason,
    };
}

/** Only a current verified student status unlocks student benefits. */
export function isStudentVerified(assurance: StudentAssurance | null): boolean {
    return assurance?.studentStatus === 'verified';
}

function formatValidUntil(value: string | null): string | null {
    if (!value) return null;
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) return null;
    return parsed.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function schoolMethodLabel(method: StudentAssurance['schoolAccountMethod']): string | null {
    if (method === 'email_otp') return 'school email code';
    if (method === 'google_workspace') return 'Google Workspace';
    if (method === 'microsoft_school') return 'Microsoft school account';
    return null;
}

function enrollmentMethodLabel(method: StudentAssurance['enrollmentMethod']): string | null {
    if (method === 'registration') return 'school registration record';
    if (method === 'microsoft_graph') return 'Microsoft school record';
    return null;
}

function reasonLabel(reason: StudentAssurance['reason']): string {
    switch (reason) {
        case 'awaiting_enrollment': return 'complete a current enrollment check below';
        case 'evidence_expired': return 'enrollment evidence expired';
        case 'enrollment_denied': return 'an enrollment check did not confirm you';
        case 'consent_withdrawn': return 'verification consent was withdrawn';
        case 'identity_changed': return 'your school email changed';
        case 'policy_changed': return 'your school updated its verification rules';
        case 'inactive': return 'your student profile is inactive';
        case 'provider_unavailable': return 'the enrollment check is temporarily unavailable';
        default: return '';
    }
}

/** Independent school-account label with its own expiry; never an enrollment claim. */
export function schoolAccountLabel(assurance: StudentAssurance): string {
    if (assurance.schoolAccountStatus === 'verified') {
        const method = schoolMethodLabel(assurance.schoolAccountMethod);
        const validUntil = formatValidUntil(assurance.schoolAccountValidUntil);
        return `Verified${method ? ` (${method})` : ''}${validUntil ? `, valid until ${validUntil}` : ''}`;
    }
    if (assurance.schoolAccountStatus === 'expired') {
        const validUntil = formatValidUntil(assurance.schoolAccountValidUntil);
        return validUntil ? `Expired on ${validUntil}` : 'Expired';
    }
    return 'Not verified';
}

/** Independent student-status label with its own expiry and precise reason. */
export function studentStatusLabel(assurance: StudentAssurance): string {
    if (assurance.studentStatus === 'verified') {
        const method = enrollmentMethodLabel(assurance.enrollmentMethod);
        const validUntil = formatValidUntil(assurance.studentValidUntil);
        return `Verified${method ? ` (${method})` : ''}${validUntil ? `, valid until ${validUntil}` : ''}`;
    }
    if (assurance.studentStatus === 'pending') {
        const reason = reasonLabel(assurance.reason);
        return reason ? `Pending — ${reason}` : 'Pending';
    }
    if (assurance.studentStatus === 'expired') {
        const validUntil = formatValidUntil(assurance.studentValidUntil);
        const reason = assurance.reason === 'evidence_expired' ? '' : reasonLabel(assurance.reason);
        return `${validUntil ? `Expired on ${validUntil}` : 'Expired'}${reason ? ` — ${reason}` : ''}`;
    }
    if (assurance.studentStatus === 'denied') return 'Denied — an enrollment check did not confirm you';
    if (assurance.studentStatus === 'revoked') {
        const reason = reasonLabel(assurance.reason);
        return reason ? `Revoked — ${reason}` : 'Revoked';
    }
    return 'Inactive — your student profile is inactive';
}
