import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import type { PoolClient } from 'pg';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../common/errors/AppError.js';
import { db } from '../../config/database.js';
import {
    purgeAcademicProfileForUser,
    readAcademicProfile,
    saveAcademicProfile,
    type AcademicProgrammeReference,
} from '../../services/academic-profile/academic-profile.service.js';
import { withTestClient } from './test-database.js';

after(() => db.close());

type Fixture = {
    userId: string;
    studentId: string;
    universityId: string | null;
    email: string;
};

const enabled = { featureEnabled: true } as const;

const syntheticReference: AcademicProgrammeReference = {
    sourceVersion: 'INTEGRATION-REF-v1',
    findReviewedRule: (programmeId: string, route: string) => {
        if (programmeId === 'INT-001' && route === 'utme') {
            return { durationYears: 4, ruleId: 'INT-001:utme', sourceVersion: 'INTEGRATION-REF-v1' };
        }
        return null;
    },
};

function uniqueLabel(): string {
    return randomUUID().replaceAll('-', '').slice(0, 12);
}

async function createUniversity(client: PoolClient, label: string): Promise<string> {
    const inserted = await client.query<{ id: string }>(
        `INSERT INTO universities (name, country, is_active) VALUES ($1, 'Nigeria', true) RETURNING id`,
        [`Academic Profile School ${label}`],
    );
    const id = inserted.rows[0]?.id;
    assert.ok(id);
    return id;
}

async function createStudent(client: PoolClient, universityId: string | null): Promise<Fixture> {
    const label = uniqueLabel();
    const email = `academic-profile-${label}@example.invalid`;
    const userId = (await client.query<{ id: string }>(
        `INSERT INTO users (email, role) VALUES ($1, 'student') RETURNING id`,
        [email],
    )).rows[0]?.id;
    assert.ok(userId);
    const studentId = (await client.query<{ id: string }>(
        `INSERT INTO students (user_id, name, university_id, registration_number)
         VALUES ($1, $2, $3, null)
         RETURNING id`,
        [userId, `Academic Student ${label}`, universityId],
    )).rows[0]?.id;
    assert.ok(studentId);
    return { userId, studentId, universityId, email };
}

async function profileRowCount(client: PoolClient, userId: string): Promise<number> {
    const counted = await client.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM student_academic_profiles WHERE user_id = $1`,
        [userId],
    );
    return Number(counted.rows[0]?.count ?? '0');
}

test('unbound students save and read claimed institutions through real constraints', async () => {
    await withTestClient(async (client) => {
        const fixture = await createStudent(client, null);
        const pool = db.getPool();
        const saved = await saveAcademicProfile(pool, fixture.userId, {
            expectedRevision: 0,
            claimedInstitution: { state: 'supplied', value: { name: 'Example University', countryCode: 'ng' } },
            programme: { state: 'supplied', value: { programmeId: null, courseLabel: 'Synthetic Physics' } },
            entryYear: { state: 'supplied', value: 2022 },
            entryRoute: { state: 'supplied', value: 'utme' },
            expectedGraduationYear: { state: 'supplied', value: { kind: 'self_reported', year: 2026 } },
        }, enabled);
        assert.equal(saved.revision, 1);
        assert.deepEqual(saved.institution, { displayName: 'Example University', countryCode: 'NG', binding: 'student_claimed' });
        assert.equal(saved.fields.graduationYearOrigin, 'self_reported');

        const updated = await saveAcademicProfile(pool, fixture.userId, {
            expectedRevision: 1,
            entryRoute: { state: 'unknown' },
            expectedGraduationYear: { state: 'skipped' },
        }, enabled);
        assert.equal(updated.revision, 2);
        assert.deepEqual(updated.fields.entryRoute, { state: 'unknown' });
        assert.deepEqual(updated.fields.expectedGraduationYear, { state: 'skipped' });
        assert.equal(updated.fields.graduationYearOrigin, null);

        const read = await readAcademicProfile(pool, fixture.userId, enabled);
        assert.equal(read.revision, 2);
        assert.deepEqual(read.fields.claimedInstitution, { state: 'supplied', value: { name: 'Example University', countryCode: 'NG' } });
        assert.equal(await profileRowCount(client, fixture.userId), 1);
    });
});

test('a failing assurance query does not abort the profile save', async () => {
    await withTestClient(async (client) => {
        const fixture = await createStudent(client, null);
        const pool = db.getPool();
        const saved = await saveAcademicProfile(pool, fixture.userId, {
            expectedRevision: 0,
            programme: { state: 'supplied', value: { programmeId: null, courseLabel: 'Synthetic Physics' } },
        }, {
            ...enabled,
            readAssurance: async (tx) => {
                await tx.query('SELECT * FROM academic_profile_missing_relation');
                throw new Error('unreachable: missing relation must fail first');
            },
        });
        assert.equal(saved.assuranceState, 'unavailable');
        assert.equal(saved.revision, 1);
        assert.equal(await profileRowCount(client, fixture.userId), 1);
        const reread = await readAcademicProfile(pool, fixture.userId, enabled);
        assert.equal(reread.revision, 1);
        assert.deepEqual(reread.fields.programme, { state: 'supplied', value: { programmeId: null, courseLabel: 'Synthetic Physics' } });
    });
});

test('unrelated users cannot see or affect each other profiles', async () => {
    await withTestClient(async (client) => {
        const first = await createStudent(client, null);
        const second = await createStudent(client, null);
        const pool = db.getPool();
        await saveAcademicProfile(pool, first.userId, {
            expectedRevision: 0,
            claimedInstitution: { state: 'supplied', value: { name: 'First School', countryCode: 'NG' } },
        }, enabled);

        const other = await readAcademicProfile(pool, second.userId, enabled);
        assert.equal(other.revision, 0);
        assert.deepEqual(other.fields.claimedInstitution, { state: 'unanswered' });

        await saveAcademicProfile(pool, second.userId, {
            expectedRevision: 0,
            entryYear: { state: 'supplied', value: 2021 },
        }, enabled);
        const reread = await readAcademicProfile(pool, first.userId, enabled);
        assert.equal(reread.revision, 1);
        assert.deepEqual(reread.fields.claimedInstitution, { state: 'supplied', value: { name: 'First School', countryCode: 'NG' } });
        assert.deepEqual(reread.fields.entryYear, { state: 'unanswered' });
    });
});

test('soft-deleted accounts lose academic visibility while purge stays available', async () => {
    await withTestClient(async (client) => {
        const fixture = await createStudent(client, null);
        const pool = db.getPool();
        await saveAcademicProfile(pool, fixture.userId, {
            expectedRevision: 0,
            entryYear: { state: 'supplied', value: 2022 },
        }, enabled);
        await client.query(`UPDATE users SET deleted_at = clock_timestamp() WHERE id = $1`, [fixture.userId]);

        await assert.rejects(readAcademicProfile(pool, fixture.userId, enabled), NotFoundError);
        await assert.rejects(
            saveAcademicProfile(pool, fixture.userId, { expectedRevision: 1 }, enabled),
            NotFoundError,
        );

        const purged = await pool.connect().then(async (owned) => {
            try {
                return await purgeAcademicProfileForUser(owned, fixture.userId);
            } finally {
                owned.release();
            }
        });
        assert.deepEqual(purged, { deleted: true });
        assert.equal(await profileRowCount(client, fixture.userId), 0);
    });
});

test('suspended students keep read access but cannot save', async () => {
    await withTestClient(async (client) => {
        const fixture = await createStudent(client, null);
        const pool = db.getPool();
        await saveAcademicProfile(pool, fixture.userId, {
            expectedRevision: 0,
            entryYear: { state: 'supplied', value: 2022 },
        }, enabled);
        await client.query(`UPDATE students SET status = 'suspended' WHERE id = $1`, [fixture.studentId]);

        const read = await readAcademicProfile(pool, fixture.userId, enabled);
        assert.equal(read.revision, 1);
        await assert.rejects(
            saveAcademicProfile(pool, fixture.userId, { expectedRevision: 1 }, enabled),
            ForbiddenError,
        );
    });
});

test('concurrent institution change conflicts without committing old-school values', async () => {
    await withTestClient(async (client) => {
        const label = uniqueLabel();
        const firstUniversity = await createUniversity(client, `first-${label}`);
        const secondUniversity = await createUniversity(client, `second-${label}`);
        const fixture = await createStudent(client, firstUniversity);
        const pool = db.getPool();
        await saveAcademicProfile(pool, fixture.userId, {
            expectedRevision: 0,
            programme: { state: 'supplied', value: { programmeId: null, courseLabel: 'Synthetic Chemistry' } },
            entryYear: { state: 'supplied', value: 2022 },
        }, enabled);

        await client.query(`UPDATE students SET university_id = $1 WHERE id = $2`, [secondUniversity, fixture.studentId]);
        await assert.rejects(
            saveAcademicProfile(pool, fixture.userId, {
                expectedRevision: 1,
                entryRoute: { state: 'supplied', value: 'utme' },
            }, enabled),
            (error: unknown) => {
                assert.ok(error instanceof ConflictError);
                assert.equal((error.details as { code?: unknown } | undefined)?.code, 'ACADEMIC_PROFILE_INSTITUTION_CHANGED');
                return true;
            },
        );

        const reread = await readAcademicProfile(pool, fixture.userId, enabled);
        assert.equal(reread.revision, 2);
        assert.deepEqual(reread.fields.programme, { state: 'unanswered' });
        assert.deepEqual(reread.fields.entryYear, { state: 'unanswered' });
        assert.equal(reread.institution.binding, 'server_bound');
        assert.ok((reread.institution.displayName ?? '').includes(`second-${label}`));

        const retry = await saveAcademicProfile(pool, fixture.userId, {
            expectedRevision: 2,
            entryRoute: { state: 'supplied', value: 'utme' },
        }, enabled);
        assert.equal(retry.revision, 3);
        assert.deepEqual(retry.fields.entryRoute, { state: 'supplied', value: 'utme' });
    });
});

test('optimistic revisions serialize concurrent saves', async () => {
    await withTestClient(async (client) => {
        const fixture = await createStudent(client, null);
        const pool = db.getPool();
        await saveAcademicProfile(pool, fixture.userId, {
            expectedRevision: 0,
            entryYear: { state: 'supplied', value: 2022 },
        }, enabled);
        const outcomes = await Promise.allSettled([
            saveAcademicProfile(pool, fixture.userId, {
                expectedRevision: 1,
                entryRoute: { state: 'supplied', value: 'utme' },
            }, enabled),
            saveAcademicProfile(pool, fixture.userId, {
                expectedRevision: 1,
                entryRoute: { state: 'supplied', value: 'de_200' },
            }, enabled),
        ]);
        const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
        const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
        assert.equal(fulfilled.length, 1);
        assert.equal(rejected.length, 1);
        const reason = (rejected[0] as PromiseRejectedResult).reason;
        assert.ok(reason instanceof ConflictError);
        const read = await readAcademicProfile(pool, fixture.userId, enabled);
        assert.equal(read.revision, 2);
    });
});

test('academic saves never touch identity or eligibility columns', async () => {
    await withTestClient(async (client) => {
        const universityId = await createUniversity(client, uniqueLabel());
        const fixture = await createStudent(client, universityId);
        const before = (await client.query(
            `SELECT identity_version, university_id, registration_number, university, name
             FROM students WHERE id = $1`,
            [fixture.studentId],
        )).rows[0];
        const pool = db.getPool();
        await saveAcademicProfile(pool, fixture.userId, {
            expectedRevision: 0,
            programme: { state: 'supplied', value: { programmeId: null, courseLabel: 'Synthetic Biology' } },
            entryYear: { state: 'supplied', value: 2021 },
            entryRoute: { state: 'supplied', value: 'utme' },
        }, enabled);
        await saveAcademicProfile(pool, fixture.userId, {
            expectedRevision: 1,
            expectedGraduationYear: { state: 'supplied', value: { kind: 'self_reported', year: 2025 } },
        }, enabled);
        const after = (await client.query(
            `SELECT identity_version, university_id, registration_number, university, name
             FROM students WHERE id = $1`,
            [fixture.studentId],
        )).rows[0];
        assert.deepEqual(after, before);
    });
});

test('feature-off rejects writes while reads and purge stay available', async () => {
    await withTestClient(async (client) => {
        const fixture = await createStudent(client, null);
        const pool = db.getPool();
        await saveAcademicProfile(pool, fixture.userId, {
            expectedRevision: 0,
            entryYear: { state: 'supplied', value: 2022 },
        }, enabled);

        await assert.rejects(
            saveAcademicProfile(pool, fixture.userId, { expectedRevision: 1 }),
            ForbiddenError,
        );
        const read = await readAcademicProfile(pool, fixture.userId);
        assert.equal(read.featureEnabled, false);
        assert.equal(read.estimate, null);
        assert.equal(read.promptDecision, 'continue');
        assert.deepEqual(read.fields.entryYear, { state: 'supplied', value: 2022 });

        const owned = await pool.connect();
        try {
            const purged = await purgeAcademicProfileForUser(owned, fixture.userId);
            assert.deepEqual(purged, { deleted: true });
        } finally {
            owned.release();
        }
    });
});

test('physical account deletion cascades to the academic row', async () => {
    await withTestClient(async (client) => {
        const fixture = await createStudent(client, null);
        const pool = db.getPool();
        await saveAcademicProfile(pool, fixture.userId, {
            expectedRevision: 0,
            entryYear: { state: 'supplied', value: 2022 },
        }, enabled);
        assert.equal(await profileRowCount(client, fixture.userId), 1);
        await client.query(`DELETE FROM users WHERE id = $1`, [fixture.userId]);
        assert.equal(await profileRowCount(client, fixture.userId), 0);
    });
});

test('blocked programme reference rejects accepted estimates end to end', async () => {
    await withTestClient(async (client) => {
        const fixture = await createStudent(client, null);
        const pool = db.getPool();
        const saved = await saveAcademicProfile(pool, fixture.userId, {
            expectedRevision: 0,
            programme: { state: 'supplied', value: { programmeId: 'INT-001', courseLabel: null } },
            entryYear: { state: 'supplied', value: 2022 },
            entryRoute: { state: 'supplied', value: 'utme' },
        }, enabled);
        assert.equal(saved.estimate, null);
        assert.ok(typeof saved.referenceVersion === 'string' && saved.referenceVersion.length > 0);
        await assert.rejects(
            saveAcademicProfile(pool, fixture.userId, {
                expectedRevision: 1,
                expectedGraduationYear: { state: 'supplied', value: { kind: 'accept_estimate', year: 2026 } },
            }, enabled),
            BadRequestError,
        );
    });
});

test('reviewed estimates persist calculated origin and basis end to end', async () => {
    await withTestClient(async (client) => {
        const fixture = await createStudent(client, null);
        const pool = db.getPool();
        const saved = await saveAcademicProfile(pool, fixture.userId, {
            expectedRevision: 0,
            programme: { state: 'supplied', value: { programmeId: 'INT-001', courseLabel: null } },
            entryYear: { state: 'supplied', value: 2022 },
            entryRoute: { state: 'supplied', value: 'utme' },
            expectedGraduationYear: { state: 'supplied', value: { kind: 'accept_estimate', year: 2026 } },
        }, { featureEnabled: true, reference: syntheticReference });
        assert.equal(saved.fields.graduationYearOrigin, 'calculated');
        assert.deepEqual(saved.fields.estimateBasis, {
            programmeId: 'INT-001',
            entryYear: 2022,
            entryRoute: 'utme',
            ruleId: 'INT-001:utme',
            sourceVersion: 'INTEGRATION-REF-v1',
        });
        const read = await readAcademicProfile(pool, fixture.userId, { featureEnabled: true, reference: syntheticReference });
        assert.equal(read.fields.graduationYearOrigin, 'calculated');
        assert.deepEqual(read.estimate, { year: 2026, ruleId: 'INT-001:utme', sourceVersion: 'INTEGRATION-REF-v1' });
    });
});

test('default wiring reports pending assurance with no continuation for fresh fixtures', async () => {
    await withTestClient(async (client) => {
        const unbound = await createStudent(client, null);
        const bound = await createStudent(client, await createUniversity(client, uniqueLabel()));
        const pool = db.getPool();
        for (const fixture of [unbound, bound]) {
            const projection = await readAcademicProfile(pool, fixture.userId, enabled);
            assert.equal(projection.assuranceState, 'available');
            assert.equal(projection.assurance?.studentStatus, 'pending');
            assert.equal(projection.verificationContinuationAvailable, false);
            assert.deepEqual(projection.verificationRequirements, []);
            assert.equal(projection.promptDecision, 'complete_profile');
        }
        const boundProjection = await readAcademicProfile(pool, bound.userId, enabled);
        assert.equal(boundProjection.institution.binding, 'server_bound');
    });
});
