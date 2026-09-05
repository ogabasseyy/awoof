import type { PoolClient } from 'pg';
import { BadRequestError, NotFoundError } from '../../common/errors/AppError.js';
import type { StudentContext } from './eligibility.types.js';

type LockedUser = {
    id: string;
    email: string;
    role: string;
    deleted_at: Date | null;
};

type LockedStudent = {
    id: string;
    university_id: string | null;
    identity_version: number;
    status: string;
};

type LockedUniversity = {
    id: string;
    is_active: boolean;
    verification_policy_version: number;
};

async function lockUser(tx: PoolClient, userId: string): Promise<LockedUser> {
    const result = await tx.query<LockedUser>(
        `SELECT id, email, role, deleted_at
         FROM users
         WHERE id = $1
         FOR UPDATE`,
        [userId],
    );
    const user = result.rows[0];
    if (!user) throw new NotFoundError('Student user not found');
    return user;
}

async function lockStudent(tx: PoolClient, userId: string): Promise<LockedStudent> {
    const result = await tx.query<LockedStudent>(
        `SELECT id, university_id, identity_version, status
         FROM students
         WHERE user_id = $1
         FOR UPDATE`,
        [userId],
    );
    const student = result.rows[0];
    if (!student) throw new NotFoundError('Student profile not found');
    return student;
}

async function lockUniversity(tx: PoolClient, universityId: string): Promise<LockedUniversity> {
    const result = await tx.query<LockedUniversity>(
        `SELECT id, is_active, verification_policy_version
         FROM universities
         WHERE id = $1
         FOR UPDATE`,
        [universityId],
    );
    const university = result.rows[0];
    if (!university) throw new NotFoundError('Canonical university not found');
    return university;
}

export async function lockStudentContext(tx: PoolClient, userId: string): Promise<StudentContext> {
    const user = await lockUser(tx, userId);
    const student = await lockStudent(tx, userId);
    if (!student.university_id) throw new NotFoundError('Student has no canonical university');
    const university = await lockUniversity(tx, student.university_id);

    return {
        userId: user.id,
        studentId: student.id,
        email: user.email.trim().toLowerCase(),
        universityId: university.id,
        identityVersion: student.identity_version,
        policyVersion: university.verification_policy_version,
        active: user.deleted_at === null && user.role === 'student' && student.status === 'active' && university.is_active,
    };
}

export async function selectStudentInstitution(
    tx: PoolClient,
    userId: string,
    universityId: string,
): Promise<StudentContext> {
    const user = await lockUser(tx, userId);
    const student = await lockStudent(tx, userId);
    if (user.deleted_at !== null || user.role !== 'student' || student.status !== 'active') {
        throw new BadRequestError('Active student context required');
    }

    const universityIds = [student.university_id, universityId]
        .filter((id): id is string => id !== null)
        .filter((id, index, all) => all.indexOf(id) === index)
        .sort();
    const lockedUniversities = new Map<string, LockedUniversity>();
    for (const id of universityIds) lockedUniversities.set(id, await lockUniversity(tx, id));

    const target = lockedUniversities.get(universityId);
    if (!target?.is_active) throw new BadRequestError('Target institution is inactive');
    if (student.university_id !== universityId) {
        const name = await tx.query<{ name: string }>('SELECT name FROM universities WHERE id = $1', [universityId]);
        const universityName = name.rows[0]?.name;
        if (!universityName) throw new NotFoundError('Target institution not found');
        await tx.query(
            `UPDATE students
             SET university_id = $2, university = $3, registration_number = NULL
             WHERE id = $1`,
            [student.id, universityId, universityName],
        );
    }
    return lockStudentContext(tx, userId);
}
