import assert from 'node:assert/strict';
import { once } from 'node:events';
import test, { type TestContext } from 'node:test';
import express, { Router } from 'express';
import { db } from '../config/database.js';
import { errorHandler } from '../common/middleware/errorHandler.js';
import { asyncHandler } from '../common/middleware/errorHandler.js';
import { authenticate, requireRole } from '../middleware/auth.middleware.js';
import { requireCurrentAdmin } from '../middleware/current-admin.js';
import { AdminStudentController } from './admin-student.controller.js';
import { jwtService } from '../services/auth/jwt.service.js';
import type { StudentAssurance } from '../services/verification/student-assurance.types.js';

const actorId = '8d4f1c2a-9d3e-4f5a-8b1c-2d3e4f5a6b7c';
const firstUserId = '11111111-1111-4111-8111-111111111111';
const secondUserId = '22222222-2222-4222-8222-222222222222';

function token(role: 'admin' | 'student') {
    return jwtService.generateAccessToken({ userId: actorId, email: `${role}@example.invalid`, role });
}

function verifiedAssurance(): StudentAssurance {
    return {
        schoolAccountStatus: 'verified',
        schoolAccountMethod: 'email_otp',
        schoolAccountValidUntil: '2026-12-01T00:00:00.000Z',
        studentStatus: 'verified',
        enrollmentMethod: 'registration',
        studentValidUntil: '2026-11-01T00:00:00.000Z',
        reason: null,
    };
}

function pendingAssurance(): StudentAssurance {
    return {
        schoolAccountStatus: 'verified',
        schoolAccountMethod: 'email_otp',
        schoolAccountValidUntil: '2026-12-01T00:00:00.000Z',
        studentStatus: 'pending',
        enrollmentMethod: null,
        studentValidUntil: null,
        reason: 'awaiting_enrollment',
    };
}

function listRow(userId: string, name: string) {
    return {
        id: `student-${userId.slice(0, 8)}`,
        user_id: userId,
        name,
        university: null,
        registration_number: null,
        phone_number: null,
        status: 'active',
        verification_date: null,
        created_at: new Date('2026-08-01T00:00:00.000Z'),
        email: `${name}@example.invalid`,
        university_name: 'Approved Alpha University',
        total_spent: '125.00',
        total_savings: '25.00',
        unknown_savings_count: '0',
    };
}

type QueryLog = { text: string; params: unknown[] | undefined };

async function withServer(
    t: TestContext,
    options: {
        role?: string;
        rows?: ReturnType<typeof listRow>[];
        total?: number;
        assurance?: Map<string, StudentAssurance>;
        queries?: QueryLog[];
    },
    operation: (baseUrl: string) => Promise<void>,
): Promise<void> {
    const rows = options.rows ?? [listRow(firstUserId, 'ada'), listRow(secondUserId, 'bisi')];
    const assurance = options.assurance ?? new Map([
        [firstUserId, verifiedAssurance()],
        [secondUserId, pendingAssurance()],
    ]);
    const seen: string[][] = [];
    t.mock.method(db, 'query', async (text: string, params?: unknown[]) => {
        options.queries?.push({ text, params });
        if (text === 'SELECT role, deleted_at FROM users WHERE id = $1') {
            return { rows: [{ role: options.role ?? 'admin', deleted_at: null }], rowCount: 1 };
        }
        if (text.includes('COUNT(DISTINCT s.id)')) {
            return { rows: [{ total: options.total ?? rows.length }], rowCount: 1 };
        }
        if (text.includes('FROM students s')) {
            return { rows, rowCount: rows.length };
        }
        throw new Error(`Unexpected admin students query: ${text.slice(0, 120)}`);
    });
    const controller = new AdminStudentController({
        readAssurancePage: async (userIds: string[]) => {
            seen.push(userIds);
            return assurance;
        },
    });
    const router = Router();
    router.use(authenticate);
    router.use(requireRole('admin'));
    router.use(requireCurrentAdmin);
    router.get('/students', asyncHandler(controller.getStudents.bind(controller)));
    const app = express();
    app.use('/admin', router);
    app.use(errorHandler);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP fixture did not expose a loopback port');
    try {
        await operation(`http://127.0.0.1:${address.port}/admin/students`);
    } finally {
        server.close();
        await once(server, 'close');
    }
    (options as { seen?: string[][] }).seen = seen;
}

test('admin students requires authentication', async (t) => {
    await withServer(t, {}, async (baseUrl) => {
        const response = await fetch(baseUrl);
        assert.equal(response.status, 401);
    });
});

test('admin students rejects non-admin roles', async (t) => {
    await withServer(t, {}, async (baseUrl) => {
        const response = await fetch(baseUrl, { headers: { authorization: `Bearer ${token('student')}` } });
        assert.equal(response.status, 401);
    });
});

test('admin students rejects a demoted administrator after the JWT was issued', async (t) => {
    await withServer(t, { role: 'student' }, async (baseUrl) => {
        const response = await fetch(baseUrl, { headers: { authorization: `Bearer ${token('admin')}` } });
        assert.equal(response.status, 403);
    });
});

test('admin students reports enrollment assurance with provenance per row', async (t) => {
    await withServer(t, {}, async (baseUrl) => {
        const response = await fetch(baseUrl, { headers: { authorization: `Bearer ${token('admin')}` } });
        assert.equal(response.status, 200);
        const body = await response.json() as { data: { students: Record<string, unknown>[] } };
        assert.equal(body.data.students.length, 2);
        assert.deepEqual(body.data.students[0]?.studentAssurance, verifiedAssurance());
        assert.deepEqual(body.data.students[1]?.studentAssurance, pendingAssurance());
    });
});

test('admin students passes every status through without conflation', async (t) => {
    const statuses: StudentAssurance['studentStatus'][] = ['pending', 'verified', 'expired', 'denied', 'revoked', 'inactive'];
    const rows = statuses.map((status, index) =>
        listRow(`33333333-3333-4333-8333-33333333333${index}`, `student-${status}`));
    const assurance = new Map(rows.map((row, index) => [row.user_id as string, {
        ...pendingAssurance(),
        studentStatus: statuses[index]!,
        reason: statuses[index] === 'verified' ? null : 'awaiting_enrollment',
    } as StudentAssurance]));
    await withServer(t, { rows, assurance }, async (baseUrl) => {
        const response = await fetch(baseUrl, { headers: { authorization: `Bearer ${token('admin')}` } });
        assert.equal(response.status, 200);
        const body = await response.json() as { data: { students: { studentAssurance: StudentAssurance }[] } };
        assert.deepEqual(body.data.students.map((row) => row.studentAssurance.studentStatus), statuses);
    });
});

test('admin students keeps pagination scoped and search exact', async (t) => {
    const queries: QueryLog[] = [];
    const options = { queries };
    await withServer(t, options, async (baseUrl) => {
        const response = await fetch(`${baseUrl}?page=2&limit=500&search=ada`, {
            headers: { authorization: `Bearer ${token('admin')}` },
        });
        assert.equal(response.status, 200);
        const body = await response.json() as { data: { students: unknown[] }; meta: { page: number; limit: number } };
        assert.equal(body.meta.page, 2);
        assert.equal(body.meta.limit, 100);
        const list = queries.find((query) => query.text.includes('FROM students s'));
        assert.ok(list);
        assert.deepEqual(list.params, ['%ada%', 100, 100]);
    });
    const seen = (options as unknown as { seen: string[][] }).seen;
    assert.deepEqual(seen, [[firstUserId, secondUserId]]);
});
