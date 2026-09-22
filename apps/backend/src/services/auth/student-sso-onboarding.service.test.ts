import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import {
    decodeProviderObservation,
    encodeProviderObservation,
    hasCurrentMicrosoftMembership,
    writeSsoSchoolAssertion,
} from './student-sso-onboarding.service.js';
import type { ProviderObservation } from './student-sso.types.js';
import type { StudentContext } from '../verification/eligibility.types.js';

const GOOGLE_OBSERVATION: ProviderObservation = {
    provider: 'google',
    issuer: 'https://accounts.google.com',
    subject: 'google-subject-1',
    email: 'student@students.school.example',
    mailboxVerified: true,
    realm: 'students.school.example',
    schoolMembershipAttested: true,
};

function throwingClient(): PoolClient {
    return {
        query: async () => {
            throw new Error('storage must not be touched');
        },
    } as unknown as PoolClient;
}

function studentContext(): StudentContext {
    return {
        userId: '11111111-1111-4111-8111-111111111111',
        studentId: '22222222-2222-4222-8222-222222222222',
        email: 'student@students.school.example',
        universityId: '33333333-3333-4333-8333-333333333333',
        identityVersion: 1,
        policyVersion: 1,
        active: true,
    };
}

test('observation codec round-trips every field without loss', () => {
    const decoded = decodeProviderObservation(encodeProviderObservation(GOOGLE_OBSERVATION));
    assert.deepEqual(decoded, GOOGLE_OBSERVATION);
});

test('observation codec preserves a null Microsoft email', () => {
    const microsoft: ProviderObservation = {
        provider: 'microsoft',
        issuer: 'https://login.microsoftonline.com/tenant/v2.0',
        subject: 'microsoft-subject-1',
        email: null,
        mailboxVerified: false,
        realm: 'tenant',
        schoolMembershipAttested: false,
    };
    assert.deepEqual(decodeProviderObservation(encodeProviderObservation(microsoft)), microsoft);
});

test('observation decode rejects malformed and mistyped payloads before use', () => {
    const bad = [
        'not-json',
        'null',
        '[]',
        '"string"',
        JSON.stringify({ ...GOOGLE_OBSERVATION, provider: 'github' }),
        JSON.stringify({ ...GOOGLE_OBSERVATION, issuer: '' }),
        JSON.stringify({ ...GOOGLE_OBSERVATION, subject: '' }),
        JSON.stringify({ ...GOOGLE_OBSERVATION, email: 42 }),
        JSON.stringify({ ...GOOGLE_OBSERVATION, mailboxVerified: 'yes' }),
        JSON.stringify({ ...GOOGLE_OBSERVATION, realm: null }),
        JSON.stringify({ ...GOOGLE_OBSERVATION, schoolMembershipAttested: 1 }),
    ];
    for (const raw of bad) {
        assert.throws(() => decodeProviderObservation(raw), /no longer valid/);
    }
});

test('Microsoft membership with a malformed tenant fails closed without storage', async () => {
    assert.equal(
        await hasCurrentMicrosoftMembership(throwingClient(), studentContext().userId, studentContext(), 'not-a-uuid'),
        false,
    );
});

test('assertion writer records nothing for unattested observations without storage', async () => {
    const tx = throwingClient();
    const base = {
        userId: studentContext().userId,
        universityId: studentContext().universityId,
        identityVersion: 1,
        identityId: '44444444-4444-4444-8444-444444444444',
        policy: {
            id: '55555555-5555-4555-8555-555555555555',
            version: 1,
            schoolAssertionDays: 90,
            approvedUntil: new Date(Date.now() + 86_400_000),
        },
    };
    assert.equal(
        await writeSsoSchoolAssertion(tx, {
            ...base,
            observation: { ...GOOGLE_OBSERVATION, schoolMembershipAttested: false },
            microsoftMembershipAttested: false,
        }),
        'not_attested',
    );
    assert.equal(
        await writeSsoSchoolAssertion(tx, {
            ...base,
            observation: {
                provider: 'microsoft',
                issuer: 'https://login.microsoftonline.com/tenant/v2.0',
                subject: 'microsoft-subject-1',
                email: null,
                mailboxVerified: false,
                realm: 'tenant',
                schoolMembershipAttested: false,
            },
            microsoftMembershipAttested: false,
        }),
        'not_attested',
    );
});
