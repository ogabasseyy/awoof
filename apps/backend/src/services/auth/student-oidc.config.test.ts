import assert from 'node:assert/strict';
import test from 'node:test';

import {
    STUDENT_SSO_COMPLETION_PATH,
    STUDENT_SSO_GOOGLE_CALLBACK_PATH,
    STUDENT_SSO_MICROSOFT_CALLBACK_PATH,
    enabledStudentSsoProviders,
    readStudentSsoConfiguration,
} from './student-oidc.config.js';

const GOOGLE_CALLBACK = 'https://api.awoof.example/api/auth/student/sso/google/callback';
const MICROSOFT_CALLBACK = 'https://api.awoof.example/api/auth/student/sso/microsoft/callback';
const COMPLETION = 'https://app.awoof.example/auth/student/sso/complete';
// base64url-decoded length is exactly 32 bytes.
const ATTEMPT_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';

test('fixed SSO paths match the approved callback and completion routes', () => {
    assert.equal(STUDENT_SSO_GOOGLE_CALLBACK_PATH, '/api/auth/student/sso/google/callback');
    assert.equal(STUDENT_SSO_MICROSOFT_CALLBACK_PATH, '/api/auth/student/sso/microsoft/callback');
    assert.equal(STUDENT_SSO_COMPLETION_PATH, '/auth/student/sso/complete');
});

test('disabled providers require no credentials, completion URL, or attempt key', () => {
    const configuration = readStudentSsoConfiguration({});
    assert.deepEqual(configuration.google, { enabled: false });
    assert.deepEqual(configuration.microsoft, { enabled: false });
    assert.equal(configuration.completionUrl, null);
    assert.equal(configuration.attemptKey, null);
    assert.deepEqual(enabledStudentSsoProviders(configuration), []);
});

test('stale credentials while fully disabled never fail boot', () => {
    const configuration = readStudentSsoConfiguration({
        googleClientId: 'stale',
        googleCallbackUrl: 'http://insecure.invalid/callback',
        completionUrl: 'not-a-url',
        attemptKey: '!!!not-base64url!!!',
    });
    assert.deepEqual(enabledStudentSsoProviders(configuration), []);
    assert.equal(configuration.completionUrl, null);
    assert.equal(configuration.attemptKey, null);
});

test('full rollback retains a valid completion destination for in-flight returns', () => {
    const configuration = readStudentSsoConfiguration({ completionUrl: COMPLETION });
    assert.deepEqual(enabledStudentSsoProviders(configuration), []);
    assert.equal(configuration.completionUrl?.href, 'https://app.awoof.example/auth/student/sso/complete');
    assert.equal(configuration.attemptKey, null);
});

test('an enabled provider requires its client credentials and callback URL', () => {
    assert.throws(
        () => readStudentSsoConfiguration({ googleEnabled: 'true', completionUrl: COMPLETION, attemptKey: ATTEMPT_KEY }),
        /Google login client configuration is required/,
    );
    assert.throws(
        () => readStudentSsoConfiguration({
            microsoftEnabled: true,
            microsoftClientId: 'client',
            microsoftClientSecret: 'secret',
            completionUrl: COMPLETION,
            attemptKey: ATTEMPT_KEY,
        }),
        /Microsoft login callback URL is required/,
    );
});

test('callback URLs must be absolute HTTPS without credentials, fragments, or query strings', () => {
    for (const callbackUrl of [
        'http://api.awoof.example/api/auth/student/sso/google/callback',
        'https://user:pass@api.awoof.example/api/auth/student/sso/google/callback',
        'https://api.awoof.example/api/auth/student/sso/google/callback#fragment',
        'https://api.awoof.example/api/auth/student/sso/google/callback?next=/',
        'relative/path/callback',
    ]) {
        assert.throws(
            () => readStudentSsoConfiguration({
                googleEnabled: 'true',
                googleClientId: 'client',
                googleClientSecret: 'secret',
                googleCallbackUrl: callbackUrl,
                completionUrl: COMPLETION,
                attemptKey: ATTEMPT_KEY,
            }),
            /absolute HTTPS URL/,
        );
    }
});

test('callback URLs must match the fixed per-provider API path', () => {
    assert.throws(
        () => readStudentSsoConfiguration({
            googleEnabled: 'true',
            googleClientId: 'client',
            googleClientSecret: 'secret',
            googleCallbackUrl: 'https://api.awoof.example/api/auth/student/sso/microsoft/callback',
            completionUrl: COMPLETION,
            attemptKey: ATTEMPT_KEY,
        }),
        /fixed Google callback/,
    );
    assert.throws(
        () => readStudentSsoConfiguration({
            microsoftEnabled: 'true',
            microsoftClientId: 'client',
            microsoftClientSecret: 'secret',
            microsoftCallbackUrl: 'https://api.awoof.example/api/verification/microsoft/callback',
            completionUrl: COMPLETION,
            attemptKey: ATTEMPT_KEY,
        }),
        /fixed Microsoft callback/,
    );
});

test('completion URL is required with the fixed path when any provider is enabled', () => {
    assert.throws(
        () => readStudentSsoConfiguration({
            googleEnabled: 'true',
            googleClientId: 'client',
            googleClientSecret: 'secret',
            googleCallbackUrl: GOOGLE_CALLBACK,
            attemptKey: ATTEMPT_KEY,
        }),
        /completion URL is required/,
    );
    assert.throws(
        () => readStudentSsoConfiguration({
            googleEnabled: 'true',
            googleClientId: 'client',
            googleClientSecret: 'secret',
            googleCallbackUrl: GOOGLE_CALLBACK,
            completionUrl: 'https://app.awoof.example/student/verification/microsoft/complete',
            attemptKey: ATTEMPT_KEY,
        }),
        /fixed completion route/,
    );
});

test('API callbacks and the completion route must be same-site', () => {
    assert.throws(
        () => readStudentSsoConfiguration({
            googleEnabled: 'true',
            googleClientId: 'client',
            googleClientSecret: 'secret',
            googleCallbackUrl: GOOGLE_CALLBACK,
            completionUrl: 'https://other.example/auth/student/sso/complete',
            attemptKey: ATTEMPT_KEY,
        }),
        /same-site/,
    );
});

test('private registry suffixes never count as same-site', () => {
    assert.throws(
        () => readStudentSsoConfiguration({
            googleEnabled: 'true',
            googleClientId: 'client',
            googleClientSecret: 'secret',
            googleCallbackUrl: 'https://api.alice.github.io/api/auth/student/sso/google/callback',
            completionUrl: 'https://app.bob.github.io/auth/student/sso/complete',
            attemptKey: ATTEMPT_KEY,
        }),
        /same-site/,
    );
});

test('attempt key must decode from base64url to exactly 32 bytes when SSO is enabled', () => {
    assert.throws(
        () => readStudentSsoConfiguration({
            googleEnabled: 'true',
            googleClientId: 'client',
            googleClientSecret: 'secret',
            googleCallbackUrl: GOOGLE_CALLBACK,
            completionUrl: COMPLETION,
        }),
        /attempt key is required/,
    );
    for (const attemptKey of ['!!!', Buffer.alloc(31).toString('base64url'), Buffer.alloc(33).toString('base64url')]) {
        assert.throws(
            () => readStudentSsoConfiguration({
                googleEnabled: 'true',
                googleClientId: 'client',
                googleClientSecret: 'secret',
                googleCallbackUrl: GOOGLE_CALLBACK,
                completionUrl: COMPLETION,
                attemptKey,
            }),
            /32 bytes/,
        );
    }
});

test('enabled providers share one completion URL and attempt key', () => {
    const configuration = readStudentSsoConfiguration({
        googleEnabled: 'true',
        googleClientId: 'google-client',
        googleClientSecret: 'google-secret',
        googleCallbackUrl: GOOGLE_CALLBACK,
        microsoftEnabled: 'true',
        microsoftClientId: 'microsoft-client',
        microsoftClientSecret: 'microsoft-secret',
        microsoftCallbackUrl: MICROSOFT_CALLBACK,
        completionUrl: COMPLETION,
        attemptKey: ATTEMPT_KEY,
    });
    assert.deepEqual(enabledStudentSsoProviders(configuration), ['google', 'microsoft']);
    assert.equal(configuration.completionUrl?.href, 'https://app.awoof.example/auth/student/sso/complete');
    assert.equal(configuration.attemptKey, ATTEMPT_KEY);
});

test('configuration carries no per-institution entries: tenants and hosted domains come only from approved runtime policy', () => {
    const configuration = readStudentSsoConfiguration({
        googleEnabled: 'true',
        googleClientId: 'google-client',
        googleClientSecret: 'google-secret',
        googleCallbackUrl: GOOGLE_CALLBACK,
        microsoftEnabled: 'true',
        microsoftClientId: 'microsoft-client',
        microsoftClientSecret: 'microsoft-secret',
        microsoftCallbackUrl: MICROSOFT_CALLBACK,
        completionUrl: COMPLETION,
        attemptKey: ATTEMPT_KEY,
    });
    const serialized = JSON.stringify(configuration, (_key, value) => (value instanceof URL ? value.href : value));
    assert.doesNotMatch(serialized, /tenant|hosted|domain|university|institution/i);
    assert.deepEqual(Object.keys(configuration).sort(), ['attemptKey', 'completionUrl', 'google', 'microsoft']);
});
