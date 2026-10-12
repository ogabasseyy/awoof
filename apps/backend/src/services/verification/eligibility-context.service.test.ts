import assert from 'node:assert/strict';
import test from 'node:test';
import { NotFoundError } from '../../common/errors/AppError.js';
import { lockStudentContext, lockStudentContextReadOnly } from './eligibility-context.service.js';

function recordingTx(student: Record<string, unknown> = {}): { tx: unknown; statements: string[] } {
    const statements: string[] = [];
    const rows: Array<[string, unknown]> = [
        ['FROM users', { id: 'user-id', email: 'Student@Example.Invalid', role: 'student', deleted_at: null }],
        ['FROM students', { id: 'student-id', university_id: 'university-id', identity_version: 2, status: 'active', ...student }],
        ['FROM universities', { id: 'university-id', is_active: true, verification_policy_version: 7 }],
    ];
    const tx = {
        query: async (text: string): Promise<{ rows: unknown[]; rowCount: number }> => {
            const normalized = text.replace(/\s+/g, ' ').trim();
            statements.push(normalized);
            for (const [marker, row] of rows) {
                if (normalized.includes(marker)) return { rows: [row], rowCount: 1 };
            }
            throw new Error(`Unexpected query: ${normalized}`);
        },
    };
    return { tx, statements };
}

test('read-only student context takes shared locks and projects the same context', async () => {
    const locking = recordingTx();
    const locked = await lockStudentContext(locking.tx as never, 'user-id');
    assert.equal(locking.statements.length, 3);
    for (const statement of locking.statements) assert.match(statement, /FOR UPDATE$/);
    const shared = recordingTx();
    const readOnly = await lockStudentContextReadOnly(shared.tx as never, 'user-id');
    assert.equal(shared.statements.length, 3);
    assert.match(shared.statements[0]!, /FROM users WHERE id = \$1 FOR SHARE$/);
    assert.match(shared.statements[1]!, /FROM students WHERE user_id = \$1 FOR SHARE$/);
    assert.match(shared.statements[2]!, /FROM universities WHERE id = \$1 FOR KEY SHARE$/);
    assert.deepEqual(readOnly, locked);
});

test('read-only student context rejects missing institutions like the locking variant', async () => {
    const unbound = recordingTx({ university_id: null });
    await assert.rejects(lockStudentContextReadOnly(unbound.tx as never, 'user-id'), NotFoundError);
    const locking = recordingTx({ university_id: null });
    await assert.rejects(lockStudentContext(locking.tx as never, 'user-id'), NotFoundError);
});
