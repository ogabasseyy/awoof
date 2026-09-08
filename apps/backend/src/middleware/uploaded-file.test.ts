import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request, Response } from 'express';
import { db } from '../config/database.js';
import { jwtService } from '../services/auth/jwt.service.js';
import { uploadedFile } from './uploaded-file.js';

test('legacy and private identity files require a current owner or admin, while orphaned media is denied', async () => {
    const original = db.query;
    const owner = 'a58d92fe-ffca-4008-a5ba-37fbf2c652e9';
    let docs: unknown[] = [{ user_id: owner, deleted_at: null }];
    let actor: unknown[] = [{ role: 'vendor' }];
    let publicMedia = false;
    db.query = (async (sql: string) => ({ rows: sql.includes('document_front_url') ? docs : sql.includes('FROM users') ? actor : publicMedia ? [{}] : [] })) as typeof db.query;
    async function request(directory: string, userId?: string) {
        let status = 200; let sent = false;
        const headers: Record<string, string> = {};
        const req = { path: `/${directory}/b4e5c64e-c7ab-4f0d-8c12-0d8eeaf269dc.pdf`, method: 'GET', headers: { authorization: userId ? `Bearer ${jwtService.generateAccessToken({ userId, role: 'vendor', email: 'synthetic@example.invalid' })}` : undefined } } as Request;
        const res = { set: (name: string, value: string) => { headers[name] = value; }, sendStatus: (code: number) => { status = code; }, sendFile: () => { sent = true; } } as unknown as Response;
        await uploadedFile(req, res);
        return { status, sent, headers };
    }
    try {
        for (const directory of ['vendors', 'private-vendors']) {
            assert.equal((await request(directory)).status, 401);
            assert.equal((await request(directory, 'another-user')).status, 404);
            assert.equal((await request(directory, owner)).sent, true);
            assert.equal((await request(directory, owner)).headers['Cache-Control'], 'private, no-store');
            actor = [];
            assert.equal((await request(directory, owner)).status, 404);
            actor = [{ role: 'admin' }];
            assert.equal((await request(directory, 'admin-user')).sent, true);
            actor = [{ role: 'vendor' }];
        }
        docs = []; assert.equal((await request('vendors')).status, 404);
        publicMedia = true; assert.equal((await request('vendors')).sent, true);
        assert.equal((await request('private-vendors')).status, 401);
    } finally { db.query = original; }
});
