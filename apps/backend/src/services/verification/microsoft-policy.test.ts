import assert from 'node:assert/strict';
import test from 'node:test';
import { allowsTenant } from './microsoft-policy.js';
import type { MicrosoftConsentSnapshot } from './microsoft.types.js';

test('a different tenant cannot use a school policy', () => {
    assert.equal(allowsTenant({ universityId: 'school', tenantId: 'approved', version: 1,
        enabled: true, mode: 'identity_only', approvedUntil: new Date('2030-01-01'),
        termEndsAt: null, maxEvidenceHours: 24 },
    { tenantId: 'other', objectId: 'student' }, new Date('2026-09-12')), false);
});

test('policy tenant checks reject disabled and expired policies, but allow exact active tenants', () => {
    const policy = { universityId: 'school', tenantId: 'approved', version: 1,
        enabled: true, mode: 'identity_only' as const, approvedUntil: new Date('2030-01-01'),
        termEndsAt: null, maxEvidenceHours: 24 };
    const identity = { tenantId: 'approved', objectId: 'student' };
    const now = new Date('2026-09-12');
    assert.equal(allowsTenant(policy, identity, now), true);
    assert.equal(allowsTenant({ ...policy, enabled: false }, identity, now), false);
    assert.equal(allowsTenant({ ...policy, approvedUntil: new Date('2026-09-11') }, identity, now), false);
});

test('consent snapshots cannot reinterpret identity-only consent as Graph consent', async () => {
    const { sameConsentSnapshot } = await import('./microsoft-policy.js');
    const displayed: MicrosoftConsentSnapshot = { universityId: 'school', providerPolicyVersion: 1,
        noticeVersion: 'microsoft-v1', mode: 'identity_only', scopes: ['openid', 'profile'] };
    const changed: MicrosoftConsentSnapshot = { ...displayed, providerPolicyVersion: 2,
        mode: 'graph_enrollment', scopes: ['https://graph.microsoft.com/EduRoster.ReadBasic', 'openid', 'profile'] };
    assert.equal(sameConsentSnapshot(displayed, changed), false);
    assert.equal(sameConsentSnapshot(displayed, { ...displayed, scopes: [...displayed.scopes] }), true);
    assert.equal(sameConsentSnapshot(displayed, { ...displayed, providerPolicyVersion: 3 }), false);
});
