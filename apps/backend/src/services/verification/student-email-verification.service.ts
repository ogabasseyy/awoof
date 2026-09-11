import { db } from '../../config/database.js';
import { normalizeMailbox } from './eligibility-policy.service.js';

export type StudentEmailPreflight = { supported: true } | { supported: false; reason: string };

type QueryResult = { rows: Array<{ is_active: boolean; domain_approved: boolean }> };
type Queryable = { query: (text: string, values: [string, string]) => Promise<QueryResult> };

/**
 * An approved-domain preflight only. It cannot prove mailbox ownership,
 * enroll a provider, look up an account, or return student data.
 */
export function createStudentEmailPreflight(database: Queryable) {
    return async (universityId: string, email: string): Promise<StudentEmailPreflight> => {
        const mailbox = normalizeMailbox(email);
        const result = await database.query(
            `SELECT institutions.is_active,
                    EXISTS(
                        SELECT 1
                        FROM approved_student_email_domains domains
                        WHERE domains.university_id = institutions.id
                          AND domains.domain = split_part($2, '@', 2)
                          AND domains.is_active
                    ) AS domain_approved
             FROM universities institutions
             WHERE institutions.id = $1`,
            [universityId, mailbox],
        );
        const institution = result.rows[0];
        if (!institution || !institution.is_active) {
            return { supported: false, reason: 'This institution is not currently available for student signup.' };
        }
        if (!institution.domain_approved) {
            return { supported: false, reason: 'This school email domain is not approved.' };
        }
        return { supported: true };
    };
}

export async function preflightStudentEmail(universityId: string, email: string): Promise<StudentEmailPreflight> {
    return await createStudentEmailPreflight({
        query: (text, values) => db.query<{ is_active: boolean; domain_approved: boolean }>(text, values),
    })(universityId, email);
}
