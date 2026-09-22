import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { StudentSsoLinkService } from './student-sso-link.service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SID = '22222222-2222-4222-8222-222222222222';
const HANDOFF_ID = '33333333-3333-4333-8333-333333333333';
const GRANT_ID = '44444444-4444-4444-8444-444444444444';
const IDENTITY_ID = '55555555-5555-4555-8555-555555555555';

function throwingPool(): Pool {
    return {
        query: async () => {
            throw new Error('storage must not be touched');
        },
        connect: async () => {
            throw new Error('storage must not be touched');
        },
    } as unknown as Pool;
}

function emptyPool(): Pool {
    const client = {
        query: async () => ({ rows: [], rowCount: 0 }),
        release: () => undefined,
    };
    return {
        query: async () => ({ rows: [], rowCount: 0 }),
        connect: async () => client,
    } as unknown as Pool;
}

test('reauth validates purpose, password, and session before touching storage', async () => {
    const service = new StudentSsoLinkService({ pool: throwingPool(), attemptKey: 'key', isEnabled: () => true });
    await assert.rejects(
        service.reauth({ userId: USER_ID, sid: SID, password: 'Secret!123', purpose: 'login' }),
        /purpose is invalid/,
    );
    await assert.rejects(
        service.reauth({ userId: USER_ID, sid: SID, password: '', purpose: 'link' }),
        /request is invalid/,
    );
    await assert.rejects(
        service.reauth({ userId: USER_ID, sid: SID, password: 'x'.repeat(1025), purpose: 'link' }),
        /request is invalid/,
    );
    await assert.rejects(
        service.reauth({ userId: USER_ID, sid: undefined, password: 'Secret!123', purpose: 'link' }),
        /not available for this session/,
    );
    await assert.rejects(
        service.reauth({ userId: 'not-a-uuid', sid: SID, password: 'Secret!123', purpose: 'link' }),
        /reauthentication failed/,
    );
});

test('link-purpose reauth is refused while providers are disabled, without storage', async () => {
    const service = new StudentSsoLinkService({ pool: throwingPool(), attemptKey: 'key', isEnabled: () => false });
    await assert.rejects(
        service.reauth({ userId: USER_ID, sid: SID, password: 'Secret!123', purpose: 'link' }),
        /no longer valid/,
    );
});

test('unlink-purpose reauth stays available while providers are disabled', async () => {
    const service = new StudentSsoLinkService({ pool: emptyPool(), attemptKey: 'key', isEnabled: () => false });
    // An empty user table fails authentication, proving the disabled gate was
    // not consulted before storage.
    await assert.rejects(
        service.reauth({ userId: USER_ID, sid: SID, password: 'Secret!123', purpose: 'unlink' }),
        /reauthentication failed/,
    );
});

test('link validates identifiers and secrets before touching storage', async () => {
    const service = new StudentSsoLinkService({ pool: throwingPool(), attemptKey: 'key', isEnabled: () => true });
    const valid = {
        userId: USER_ID,
        sid: SID,
        handoffId: HANDOFF_ID,
        handoffSecret: 'handoff-secret',
        browserCookies: [] as const,
        grantId: GRANT_ID,
        grantSecret: 'grant-secret',
    };
    await assert.rejects(service.link({ ...valid, handoffId: 'bad' }), /link is no longer valid/);
    await assert.rejects(service.link({ ...valid, grantId: 'bad' }), /link is no longer valid/);
    await assert.rejects(service.link({ ...valid, handoffSecret: '' }), /link is no longer valid/);
    await assert.rejects(service.link({ ...valid, grantSecret: '' }), /link is no longer valid/);
    await assert.rejects(service.link({ ...valid, sid: undefined }), /not available for this account/);
});

test('link is refused while providers are disabled, without storage', async () => {
    const service = new StudentSsoLinkService({ pool: throwingPool(), attemptKey: 'key', isEnabled: () => false });
    await assert.rejects(
        service.link({
            userId: USER_ID,
            sid: SID,
            handoffId: HANDOFF_ID,
            handoffSecret: 'handoff-secret',
            browserCookies: [],
            grantId: GRANT_ID,
            grantSecret: 'grant-secret',
        }),
        /link is no longer valid/,
    );
});

test('unlink validates identifiers before touching storage, and stays enabled while providers are disabled', async () => {
    const enabled = new StudentSsoLinkService({ pool: throwingPool(), attemptKey: 'key', isEnabled: () => true });
    await assert.rejects(
        enabled.unlink({ userId: USER_ID, sid: SID, identityId: 'bad', grantId: GRANT_ID, grantSecret: 'grant-secret' }),
        /unlink is no longer valid/,
    );
    await assert.rejects(
        enabled.unlink({ userId: USER_ID, sid: undefined, identityId: IDENTITY_ID, grantId: GRANT_ID, grantSecret: 'grant-secret' }),
        /not available for this account/,
    );
    // Disabled providers still reach storage: unlink is owner recovery, not
    // new issuance. The stub pool breaks context locking, proving the gate
    // was not consulted.
    const disabled = new StudentSsoLinkService({ pool: emptyPool(), attemptKey: 'key', isEnabled: () => false });
    await assert.rejects(
        disabled.unlink({ userId: USER_ID, sid: SID, identityId: IDENTITY_ID, grantId: GRANT_ID, grantSecret: 'grant-secret' }),
        /not available for this account/,
    );
});

test('identity listing rejects malformed owners and exposes no subject material', async () => {
    const service = new StudentSsoLinkService({ pool: throwingPool(), attemptKey: 'key', isEnabled: () => false });
    await assert.rejects(service.listIdentities('bad'), /not available/);
    const leaking = new StudentSsoLinkService({
        pool: {
            query: async () => ({
                rows: [{
                    id: IDENTITY_ID,
                    provider: 'google',
                    university_name: 'Fixture University',
                    linked_at: new Date('2026-09-01T00:00:00.000Z'),
                    subject: 'super-secret-subject',
                    issuer: 'https://accounts.google.com',
                    observed_email: 'student@school.example',
                }],
                rowCount: 1,
            }),
        } as unknown as Pool,
        attemptKey: 'key',
        isEnabled: () => false,
    });
    assert.deepEqual(await leaking.listIdentities(USER_ID), [{
        id: IDENTITY_ID,
        provider: 'google',
        universityName: 'Fixture University',
        linkedAt: '2026-09-01T00:00:00.000Z',
    }]);
});
