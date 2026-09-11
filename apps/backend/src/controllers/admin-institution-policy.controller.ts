import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ForbiddenError, UnauthorizedError } from '../common/errors/AppError.js';
import { success } from '../common/utils/response.js';
import { db } from '../config/database.js';
import {
    getInstitutionPolicy,
    normalizeStudentDomain,
    updateInstitutionPolicy,
} from '../services/verification/eligibility-policy.service.js';

const institutionIdSchema = z.string().uuid();
const policySchema = z.object({
    domains: z.array(z.string().min(1).max(253)).max(50),
    emailEvidenceValidityDays: z.number().int().min(1).max(365),
    enrollmentValidityDays: z.number().int().min(1).max(365),
    registrationNormalization: z.enum(['exact', 'trim_upper']).nullable(),
    isActive: z.boolean(),
}).strict();

async function withCurrentAdmin<T>(
    req: Request,
    universityId: string,
    operation: (tx: PoolClient, actorId: string, universityId: string) => Promise<T>,
): Promise<T> {
    const identity = z.string().uuid().safeParse(req.user?.userId);
    if (!identity.success) throw new UnauthorizedError('Authenticated administrator required');
    const tx = await db.getPool().connect();
    try {
        await tx.query('BEGIN');
        // A signed JWT's old role is not sufficient to approve or inspect policy.
        // Keep the same actor -> institution lock order as the policy service.
        const actor = await tx.query<{ role: string; deleted_at: Date | null }>(
            'SELECT role, deleted_at FROM users WHERE id = $1 FOR UPDATE', [identity.data],
        );
        if (actor.rows[0]?.role !== 'admin' || actor.rows[0].deleted_at !== null) {
            throw new ForbiddenError('Current administrator authority required');
        }
        const result = await operation(tx, identity.data, universityId);
        await tx.query('COMMIT');
        return result;
    } catch (error) {
        await tx.query('ROLLBACK').catch(() => undefined);
        throw error;
    } finally {
        tx.release();
    }
}

export async function readInstitutionVerificationPolicy(req: Request, res: Response): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    const universityId = institutionIdSchema.parse(req.params.id);
    const policy = await withCurrentAdmin(req, universityId, (tx, _actorId, id) => getInstitutionPolicy(tx, id));
    success(res, { data: { policy } });
}

export async function replaceInstitutionVerificationPolicy(req: Request, res: Response): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    const universityId = institutionIdSchema.parse(req.params.id);
    const input = policySchema.parse(req.body);
    input.domains = input.domains.map(normalizeStudentDomain);
    const policy = await withCurrentAdmin(req, universityId,
        (tx, actorId, id) => updateInstitutionPolicy(tx, actorId, id, input));
    success(res, { message: 'Institution verification policy updated', data: { policy } });
}

export async function deactivateInstitution(req: Request, res: Response): Promise<void> {
    const id = institutionIdSchema.parse(req.params.id);
    await withCurrentAdmin(req, id, async (tx, actorId, universityId) => {
        const current = await getInstitutionPolicy(tx, universityId);
        return updateInstitutionPolicy(tx, actorId, universityId, { ...current, isActive: false });
    });
    success(res, { message: 'University deactivated; verification history retained', data: {} });
}
