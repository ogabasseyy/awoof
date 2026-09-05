import type { PoolClient } from 'pg';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../common/errors/AppError.js';
import type { InstitutionPolicyInput } from './eligibility.types.js';

type InstitutionRow = {
    is_active: boolean;
    email_evidence_validity_days: number;
    enrollment_validity_days: number;
    registration_normalization: 'exact' | 'trim_upper' | null;
    verification_policy_version: number;
};

function validateValidityDays(value: number, label: string): void {
    if (!Number.isInteger(value) || value < 1 || value > 365) {
        throw new BadRequestError(`Invalid ${label} validity`);
    }
}

function validateNormalization(value: InstitutionPolicyInput['registrationNormalization']): void {
    if (value !== null && value !== 'exact' && value !== 'trim_upper') {
        throw new BadRequestError('Invalid registration normalization');
    }
}

export function normalizeStudentDomain(input: string): string {
    const value = input.trim().toLowerCase();
    if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value)) {
        throw new BadRequestError('Invalid student domain');
    }
    return value;
}

export function normalizeMailbox(input: string): string {
    const value = input.trim().toLowerCase();
    const parts = value.split('@');
    if (parts.length !== 2 || !parts[0] || /[\s:/]/.test(parts[0]) || !parts[1]) {
        throw new BadRequestError('Invalid mailbox');
    }
    normalizeStudentDomain(parts[1]);
    return value;
}

async function lockInstitution(tx: PoolClient, universityId: string): Promise<InstitutionRow> {
    const result = await tx.query<InstitutionRow>(
        `SELECT is_active, email_evidence_validity_days, enrollment_validity_days,
                registration_normalization, verification_policy_version
         FROM universities
         WHERE id = $1
         FOR UPDATE`,
        [universityId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundError('Institution not found');
    return row;
}

function policyFrom(row: InstitutionRow, domains: string[]): InstitutionPolicyInput & { policyVersion: number } {
    return {
        domains,
        emailEvidenceValidityDays: row.email_evidence_validity_days,
        enrollmentValidityDays: row.enrollment_validity_days,
        registrationNormalization: row.registration_normalization,
        isActive: row.is_active,
        policyVersion: row.verification_policy_version,
    };
}

export async function getInstitutionPolicy(
    tx: PoolClient,
    universityId: string,
): Promise<InstitutionPolicyInput & { policyVersion: number }> {
    const row = await lockInstitution(tx, universityId);
    const domains = await tx.query<{ domain: string }>(
        `SELECT domain
         FROM approved_student_email_domains
         WHERE university_id = $1 AND is_active
         ORDER BY domain`,
        [universityId],
    );
    return policyFrom(row, domains.rows.map((domain) => domain.domain));
}

export async function isApprovedStudentEmail(tx: PoolClient, universityId: string, email: string): Promise<boolean> {
    const mailbox = normalizeMailbox(email);
    const domain = mailbox.split('@')[1]!;
    const result = await tx.query(
        `SELECT 1
         FROM approved_student_email_domains domains
         JOIN universities institutions ON institutions.id = domains.university_id
         WHERE domains.university_id = $1
           AND domains.domain = $2
           AND domains.is_active
           AND institutions.is_active`,
        [universityId, domain],
    );
    return result.rowCount === 1;
}

export async function updateInstitutionPolicy(
    tx: PoolClient,
    actorUserId: string,
    universityId: string,
    input: InstitutionPolicyInput,
): Promise<InstitutionPolicyInput & { policyVersion: number }> {
    const actor = await tx.query<{ role: string; deleted_at: Date | null }>(
        `SELECT role, deleted_at FROM users WHERE id = $1 FOR UPDATE`,
        [actorUserId],
    );
    if (actor.rows[0]?.role !== 'admin' || actor.rows[0].deleted_at !== null) {
        throw new ForbiddenError('Current administrator authority required');
    }
    if (!Array.isArray(input.domains) || typeof input.isActive !== 'boolean') {
        throw new BadRequestError('Invalid institution policy');
    }
    validateValidityDays(input.emailEvidenceValidityDays, 'email evidence');
    validateValidityDays(input.enrollmentValidityDays, 'enrollment');
    validateNormalization(input.registrationNormalization);
    const requestedDomains = [...new Set(input.domains.map(normalizeStudentDomain))].sort();

    const current = await lockInstitution(tx, universityId);
    const currentDomains = await tx.query<{ domain: string }>(
        `SELECT domain FROM approved_student_email_domains
         WHERE university_id = $1 AND is_active
         ORDER BY domain
         FOR UPDATE`,
        [universityId],
    );
    const activeDomains = currentDomains.rows.map((domain) => domain.domain);
    const unchanged = current.is_active === input.isActive
        && current.email_evidence_validity_days === input.emailEvidenceValidityDays
        && current.enrollment_validity_days === input.enrollmentValidityDays
        && current.registration_normalization === input.registrationNormalization
        && activeDomains.length === requestedDomains.length
        && activeDomains.every((domain, index) => domain === requestedDomains[index]);
    if (unchanged) return policyFrom(current, activeDomains);

    await tx.query(
        `UPDATE universities
         SET is_active = $2,
             email_evidence_validity_days = $3,
             enrollment_validity_days = $4,
             registration_normalization = $5
         WHERE id = $1`,
        [
            universityId,
            input.isActive,
            input.emailEvidenceValidityDays,
            input.enrollmentValidityDays,
            input.registrationNormalization,
        ],
    );
    const requested = new Set(requestedDomains);
    const active = new Set(activeDomains);
    for (const domain of activeDomains) {
        if (!requested.has(domain)) {
            await tx.query(
                `UPDATE approved_student_email_domains
                 SET is_active = false
                 WHERE university_id = $1 AND domain = $2 AND is_active`,
                [universityId, domain],
            );
        }
    }
    for (const domain of requestedDomains) {
        if (!active.has(domain)) {
            await tx.query(
                `INSERT INTO approved_student_email_domains (university_id, domain, is_active, approved_by)
                 VALUES ($1, $2, true, $3)
                 ON CONFLICT (university_id, domain) DO UPDATE
                 SET is_active = true, approved_by = EXCLUDED.approved_by, approved_at = clock_timestamp()`,
                [universityId, domain, actorUserId],
            );
        }
    }
    await tx.query(
        `INSERT INTO verification_audit_events (actor_user_id, university_id, event_type, metadata)
         VALUES ($1, $2, 'institution_policy_updated', jsonb_build_object('version', (
             SELECT verification_policy_version FROM universities WHERE id = $2
         )))`,
        [actorUserId, universityId],
    );
    return getInstitutionPolicy(tx, universityId);
}
