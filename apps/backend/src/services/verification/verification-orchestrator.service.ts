import { db } from '../../config/database.js';
import { isEmailConfigured } from '../email/email.service.js';

export type VerificationMethod = 'portal' | 'email' | 'registration' | 'whatsapp';

export interface VerificationMethodInfo {
    methodType: VerificationMethod;
    isAvailable: boolean;
    priority: number;
    reason?: string;
}

type InstitutionAvailability = {
    is_active: boolean;
    has_approved_email_domain: boolean;
};

type MethodPriority = {
    method_type: VerificationMethod;
    priority_order: number;
};

const methods: VerificationMethod[] = ['portal', 'email', 'registration', 'whatsapp'];

function unavailable(methodType: VerificationMethod, priority: number, reason: string): VerificationMethodInfo {
    return { methodType, isAvailable: false, priority, reason };
}

/**
 * Public availability is policy truth. Legacy verification-method rows only
 * supply a display priority; they cannot override an approved domain or
 * silently advertise an unimplemented method.
 */
export async function getAvailableVerificationMethods(universityId: string): Promise<VerificationMethodInfo[]> {
    const institutionResult = await db.query<InstitutionAvailability>(
        `SELECT institutions.is_active,
                EXISTS (
                    SELECT 1
                    FROM approved_student_email_domains domains
                    WHERE domains.university_id = institutions.id
                      AND domains.is_active
                ) AS has_approved_email_domain
         FROM universities institutions
         WHERE institutions.id = $1`,
        [universityId],
    );
    const institution = institutionResult.rows[0];
    const configured = await db.query<MethodPriority>(
        `SELECT method_type, priority_order
         FROM university_verification_methods
         WHERE university_id = $1
         ORDER BY priority_order ASC`,
        [universityId],
    );
    const priorities = new Map(configured.rows.map((method) => [method.method_type, method.priority_order]));

    return methods.map((methodType, index) => {
        const priority = priorities.get(methodType) ?? index;
        if (!institution?.is_active) {
            return unavailable(methodType, priority, 'This institution is not currently active for verification.');
        }
        if (methodType === 'email') {
            if (!institution.has_approved_email_domain) {
                return unavailable(methodType, priority, 'No approved student email domain is active for this institution.');
            }
            if (!isEmailConfigured()) {
                return unavailable(methodType, priority, 'Student email delivery is temporarily unavailable.');
            }
            return { methodType, isAvailable: true, priority };
        }
        if (methodType === 'registration') {
            return unavailable(methodType, priority, 'Registration verification is unavailable pending the configured institution adapter.');
        }
        if (methodType === 'portal') {
            return unavailable(methodType, priority, 'Portal verification is not implemented.');
        }
        return unavailable(methodType, priority, 'WhatsApp verification is not implemented.');
    }).sort((left, right) => left.priority - right.priority);
}
