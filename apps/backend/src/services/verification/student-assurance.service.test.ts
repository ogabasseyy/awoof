import assert from 'node:assert/strict';
import test from 'node:test';
import type { EligibilityResult } from './eligibility.types.js';
import {
    resolveSchoolAccount,
    resolveStudentStatus,
    type EnrollmentAssuranceFlags,
} from './student-assurance.service.js';

const MICROSOFT_SOURCE = 'microsoft-education:v1';
const REGISTRATION_SOURCE = 'institution-registration:v1';

function flags(overrides: Partial<EnrollmentAssuranceFlags> = {}): EnrollmentAssuranceFlags {
    return {
        revokedOrWithdrawn: false,
        expiredMethod: null,
        expiredValidUntil: null,
        identityChanged: false,
        policyChanged: false,
        providerUnavailable: false,
        ...overrides,
    };
}

function eligible(source: string): EligibilityResult {
    return {
        eligible: true,
        studentId: 'student',
        universityId: 'university',
        evidenceId: 'evidence',
        processingGrantId: 'grant',
        method: 'enrollment',
        verifiedAt: new Date('2026-09-01T00:00:00.000Z'),
        expiresAt: new Date('2026-10-01T00:00:00.000Z'),
    };
}

test('eligible registration evidence projects verified with its own expiry', () => {
    assert.deepEqual(
        resolveStudentStatus(eligible(REGISTRATION_SOURCE), REGISTRATION_SOURCE, flags()),
        {
            studentStatus: 'verified',
            enrollmentMethod: 'registration',
            studentValidUntil: '2026-10-01T00:00:00.000Z',
            reason: null,
        },
    );
});

test('eligible Microsoft evidence projects the Microsoft enrollment method', () => {
    assert.deepEqual(
        resolveStudentStatus(eligible(MICROSOFT_SOURCE), MICROSOFT_SOURCE, flags()),
        {
            studentStatus: 'verified',
            enrollmentMethod: 'microsoft_graph',
            studentValidUntil: '2026-10-01T00:00:00.000Z',
            reason: null,
        },
    );
});

test('a still-valid independent enrollment wins over revoked and expired evidence', () => {
    assert.deepEqual(
        resolveStudentStatus(
            eligible(REGISTRATION_SOURCE),
            REGISTRATION_SOURCE,
            flags({ revokedOrWithdrawn: true, expiredMethod: 'microsoft_graph', expiredValidUntil: '2026-08-01T00:00:00.000Z' }),
        ).studentStatus,
        'verified',
    );
});

test('authoritative denial projects denied even when other flags are set', () => {
    assert.deepEqual(
        resolveStudentStatus(
            { eligible: false, reason: 'enrollment_denied' },
            null,
            flags({ revokedOrWithdrawn: true, expiredValidUntil: '2026-08-01T00:00:00.000Z' }),
        ),
        {
            studentStatus: 'denied',
            enrollmentMethod: null,
            studentValidUntil: null,
            reason: 'enrollment_denied',
        },
    );
});

test('inactive actor projects inactive', () => {
    assert.deepEqual(
        resolveStudentStatus({ eligible: false, reason: 'inactive' }, null, flags()),
        {
            studentStatus: 'inactive',
            enrollmentMethod: null,
            studentValidUntil: null,
            reason: 'inactive',
        },
    );
});

test('expired enrollment carries its evidence expiry and method', () => {
    assert.deepEqual(
        resolveStudentStatus(
            { eligible: false, reason: 'expired' },
            null,
            flags({ expiredMethod: 'registration', expiredValidUntil: '2026-08-01T00:00:00.000Z' }),
        ),
        {
            studentStatus: 'expired',
            enrollmentMethod: 'registration',
            studentValidUntil: '2026-08-01T00:00:00.000Z',
            reason: 'evidence_expired',
        },
    );
});

test('revoked enrollment evidence beats an expired pointer', () => {
    const resolved = resolveStudentStatus(
        { eligible: false, reason: 'expired' },
        null,
        flags({ revokedOrWithdrawn: true, expiredValidUntil: '2026-08-01T00:00:00.000Z' }),
    );
    assert.equal(resolved.studentStatus, 'revoked');
    assert.equal(resolved.reason, 'consent_withdrawn');
});

test('withdrawn enrollment consent projects revoked, never verified', () => {
    const resolved = resolveStudentStatus(
        { eligible: false, reason: 'consent_required' },
        null,
        flags({ revokedOrWithdrawn: true }),
    );
    assert.equal(resolved.studentStatus, 'revoked');
    assert.equal(resolved.reason, 'consent_withdrawn');
    assert.equal(resolved.enrollmentMethod, null);
    assert.equal(resolved.studentValidUntil, null);
});

test('a generic consent_required reason alone never implies revoked', () => {
    const resolved = resolveStudentStatus(
        { eligible: false, reason: 'consent_required' },
        null,
        flags(),
    );
    assert.equal(resolved.studentStatus, 'pending');
    assert.equal(resolved.reason, 'awaiting_enrollment');
});

test('unverified refines to the most precise pending reason', () => {
    assert.equal(
        resolveStudentStatus({ eligible: false, reason: 'unverified' }, null, flags({ identityChanged: true, policyChanged: true })).reason,
        'identity_changed',
    );
    assert.equal(
        resolveStudentStatus({ eligible: false, reason: 'unverified' }, null, flags({ policyChanged: true })).reason,
        'policy_changed',
    );
    assert.equal(
        resolveStudentStatus({ eligible: false, reason: 'unverified' }, null, flags({ providerUnavailable: true })).reason,
        'provider_unavailable',
    );
    assert.equal(
        resolveStudentStatus({ eligible: false, reason: 'unverified' }, null, flags()).reason,
        'awaiting_enrollment',
    );
});

test('unverified with withdrawn enrollment still projects revoked', () => {
    const resolved = resolveStudentStatus(
        { eligible: false, reason: 'unverified' },
        null,
        flags({ revokedOrWithdrawn: true }),
    );
    assert.equal(resolved.studentStatus, 'revoked');
    assert.equal(resolved.reason, 'consent_withdrawn');
});

test('unverified with expired enrollment evidence projects expired', () => {
    const resolved = resolveStudentStatus(
        { eligible: false, reason: 'unverified' },
        null,
        flags({ expiredMethod: 'microsoft_graph', expiredValidUntil: '2026-08-01T00:00:00.000Z' }),
    );
    assert.deepEqual(resolved, {
        studentStatus: 'expired',
        enrollmentMethod: 'microsoft_graph',
        studentValidUntil: '2026-08-01T00:00:00.000Z',
        reason: 'evidence_expired',
    });
});

test('authoritative identity and policy reasons stay pending with their reason', () => {
    assert.deepEqual(
        resolveStudentStatus({ eligible: false, reason: 'identity_changed' }, null, flags()),
        {
            studentStatus: 'pending',
            enrollmentMethod: null,
            studentValidUntil: null,
            reason: 'identity_changed',
        },
    );
    assert.deepEqual(
        resolveStudentStatus({ eligible: false, reason: 'policy_changed' }, null, flags()),
        {
            studentStatus: 'pending',
            enrollmentMethod: null,
            studentValidUntil: null,
            reason: 'policy_changed',
        },
    );
});

test('school account projects verified, expired, and unverified independently', () => {
    assert.deepEqual(
        resolveSchoolAccount({ method: 'email_otp', validUntil: '2026-10-01T00:00:00.000Z', expiredValidUntil: null }),
        { schoolAccountStatus: 'verified', schoolAccountMethod: 'email_otp', schoolAccountValidUntil: '2026-10-01T00:00:00.000Z' },
    );
    assert.deepEqual(
        resolveSchoolAccount({ method: 'email_otp', validUntil: null, expiredValidUntil: '2026-08-01T00:00:00.000Z' }),
        { schoolAccountStatus: 'expired', schoolAccountMethod: 'email_otp', schoolAccountValidUntil: '2026-08-01T00:00:00.000Z' },
    );
    assert.deepEqual(
        resolveSchoolAccount({ method: null, validUntil: null, expiredValidUntil: null }),
        { schoolAccountStatus: 'unverified', schoolAccountMethod: null, schoolAccountValidUntil: null },
    );
});

test('school account validity wins over older expired evidence', () => {
    const resolved = resolveSchoolAccount({
        method: 'email_otp',
        validUntil: '2026-10-01T00:00:00.000Z',
        expiredValidUntil: '2026-08-01T00:00:00.000Z',
    });
    assert.equal(resolved.schoolAccountStatus, 'verified');
    assert.equal(resolved.schoolAccountValidUntil, '2026-10-01T00:00:00.000Z');
});
