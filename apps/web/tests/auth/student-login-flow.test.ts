import assert from 'node:assert/strict';
import test from 'node:test';
import {
    backToEmail,
    choosePassword,
    chooseProvider,
    clearSsoAttempt,
    clearSsoHandoff,
    completeLogin,
    failLogin,
    initialLoginState,
    isSsoAttemptLive,
    loginErrorMessage,
    methodsFailed,
    methodsResolved,
    parseLoginErrorCode,
    parseLoginOptions,
    parseSsoFinishResponse,
    parseSsoLinkResponse,
    parseSsoReauthResponse,
    parseSsoRestart,
    parseSsoStart,
    readSsoAttempt,
    readSsoHandoff,
    retryAfterError,
    saveSsoAttempt,
    saveSsoHandoff,
    ssoAttemptMatches,
    ssoFailureLoginPath,
    ssoPostLoginDestination,
    startFailed,
    submitEmail,
    type LoginState,
} from '../../src/lib/student-login-flow';

const ATTEMPT_ID = '40000000-0000-4000-8000-000000000001';
const HANDOFF_ID = '40000000-0000-4000-8000-000000000002';
const ORIGIN = 'http://127.0.0.1:3117';

function state(): LoginState {
    return { ...initialLoginState, providers: [...initialLoginState.providers] };
}

function memoryStorage(): Storage {
    const values = new Map<string, string>();
    return {
        get length() { return values.size; },
        clear() { values.clear(); },
        key(index) { return [...values.keys()][index] ?? null; },
        getItem(key) { return values.get(key) ?? null; },
        removeItem(key) { values.delete(key); },
        setItem(key, value) { values.set(key, value); },
    };
}

function throwingStorage(): Storage {
    const storage = memoryStorage();
    return {
        ...storage,
        getItem() { throw new Error('denied'); },
        setItem() { throw new Error('denied'); },
        removeItem() { throw new Error('denied'); },
    };
}

test('submitEmail moves to loading_methods with a fresh request id', () => {
    const next = submitEmail(state(), 'Student@School.EXAMPLE');
    assert.equal(next.step, 'loading_methods');
    assert.equal(next.email, 'Student@School.EXAMPLE');
    assert.equal(next.requestId, 1);
    assert.equal(next.error, null);
    const again = submitEmail(next, 'other@school.example');
    assert.equal(again.requestId, 2);
});

test('stale discovery responses are ignored', () => {
    const loading = submitEmail(submitEmail(state(), 'a@school.example'), 'b@school.example');
    assert.equal(loading.requestId, 2);
    const stale = methodsResolved(loading, 1, ['microsoft']);
    assert.equal(stale, loading);
    const staleFailure = methodsFailed(loading, 1, 'boom');
    assert.equal(staleFailure, loading);
    const current = methodsResolved(loading, 2, ['microsoft']);
    assert.equal(current.step, 'methods');
    assert.deepEqual([...current.providers], ['microsoft']);
});

test('discovery without providers falls back to password', () => {
    const loading = submitEmail(state(), 'student@gmail.com');
    const next = methodsResolved(loading, 1, []);
    assert.equal(next.step, 'password');
    assert.equal(next.email, 'student@gmail.com');
    assert.equal(next.error, null);
});

test('school methods keep password hidden until explicitly selected', () => {
    const methods = methodsResolved(submitEmail(state(), 'student@school.example'), 1, ['microsoft']);
    assert.equal(methods.step, 'methods');
    const password = choosePassword(methods);
    assert.equal(password.step, 'password');
    assert.equal(password.email, 'student@school.example');
    assert.deepEqual([...password.providers], ['microsoft']);
    assert.equal(choosePassword(state()).step, 'email');
});

test('back and retry keep the typed email without resubmitting', () => {
    const methods = methodsResolved(submitEmail(state(), 'a@school.example'), 1, ['google']);
    const back = backToEmail(methods);
    assert.equal(back.step, 'email');
    assert.equal(back.email, 'a@school.example');
    assert.equal(back.requestId, methods.requestId);
    const failed = failLogin(methods, 'School sign-in is unavailable.');
    const retried = retryAfterError(failed);
    assert.equal(retried.step, 'email');
    assert.equal(retried.email, 'a@school.example');
    assert.equal(retried.error, null);
});

test('provider choice gates the redirect and start failures return to methods', () => {
    assert.equal(chooseProvider(state(), 'microsoft').step, 'email');
    const methods = methodsResolved(submitEmail(state(), 'a@school.example'), 1, ['microsoft']);
    const redirecting = chooseProvider(methods, 'microsoft');
    assert.equal(redirecting.step, 'redirecting');
    const failed = startFailed(redirecting, 'School sign-in is unavailable.');
    assert.equal(failed.step, 'methods');
    assert.deepEqual([...failed.providers], ['microsoft']);
    assert.equal(failed.error, 'School sign-in is unavailable.');
    assert.equal(completeLogin(redirecting).step, 'complete');
    assert.equal(completeLogin(methods).step, 'methods');
    assert.equal(failLogin(redirecting, 'x').step, 'error');
});

test('malformed discovery payloads are rejected', () => {
    assert.equal(parseLoginOptions(null), null);
    assert.equal(parseLoginOptions({ success: true, data: null }), null);
    assert.equal(parseLoginOptions({ success: true, data: { password: true, providers: ['saml'] } }), null);
    assert.equal(parseLoginOptions({ success: true, data: { password: true, providers: ['microsoft', 'microsoft'] } }), null);
    assert.equal(parseLoginOptions({ success: false, data: { password: true, providers: [] } }), null);
    assert.deepEqual(parseLoginOptions({ success: true, data: { password: true, providers: ['google', 'microsoft'] } }), {
        providers: ['google', 'microsoft'],
    });
    assert.deepEqual(parseLoginOptions({ success: true, data: { password: true, providers: [] } }), { providers: [] });
});

test('start responses require a safe provider authorization URL', () => {
    const base = {
        attemptId: ATTEMPT_ID,
        finishSecret: 'opaque-finish-secret',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    assert.equal(parseSsoStart(null), null);
    assert.equal(parseSsoStart({ success: true, data: { ...base, authorizationUrl: 'not-a-url' } }), null);
    assert.equal(parseSsoStart({ success: true, data: { ...base, authorizationUrl: 'http://accounts.google.com/o/oauth2/auth' } }), null);
    assert.equal(
        parseSsoStart({ success: true, data: { ...base, authorizationUrl: 'https://accounts.google.com/o/oauth2/auth#fragment' } }),
        null,
    );
    assert.equal(
        parseSsoStart({ success: true, data: { ...base, authorizationUrl: 'https://user:pass@accounts.google.com/' } }),
        null,
    );
    assert.equal(parseSsoStart({ success: true, data: { ...base, attemptId: 'not-a-uuid', authorizationUrl: 'https://accounts.google.com/o/oauth2/auth' } }), null);
    assert.equal(parseSsoStart({ success: true, data: { ...base, finishSecret: '', authorizationUrl: 'https://accounts.google.com/o/oauth2/auth' } }), null);
    assert.equal(parseSsoStart({ success: true, data: { ...base, expiresAt: 'yesterday', authorizationUrl: 'https://accounts.google.com/o/oauth2/auth' } }), null);
    const parsed = parseSsoStart({
        success: true,
        data: { ...base, authorizationUrl: 'https://accounts.google.com/o/oauth2/auth?client_id=x' },
    });
    assert.equal(parsed?.attemptId, ATTEMPT_ID);
    assert.equal(parsed?.authorizationUrl, 'https://accounts.google.com/o/oauth2/auth?client_id=x');
    // Loopback http exists only so local tests can prove redirect intent without touching a real provider.
    const loopback = parseSsoStart({
        success: true,
        data: { ...base, authorizationUrl: 'http://127.0.0.1:9/provider/auth?x=1' },
    });
    assert.equal(loopback?.authorizationUrl, 'http://127.0.0.1:9/provider/auth?x=1');
});

test('finish responses accept only the authenticated or link-required union', () => {
    const user = { id: 'user-1', email: 'a@school.example', role: 'student' };
    const tokens = { accessToken: 'access', refreshToken: 'refresh' };
    const assurance = {
        schoolAccountStatus: 'verified',
        schoolAccountMethod: 'google_workspace',
        schoolAccountValidUntil: null,
        studentStatus: 'verified',
        enrollmentMethod: 'registration',
        studentValidUntil: null,
        reason: null,
    };
    assert.equal(parseSsoFinishResponse(null), null);
    assert.equal(parseSsoFinishResponse({ success: true, data: { outcome: 'authenticated', user, tokens } }), null);
    assert.equal(
        parseSsoFinishResponse({
            success: true,
            data: { outcome: 'authenticated', user, tokens, studentAssurance: assurance, assuranceStatus: 'available' },
        })?.kind,
        'authenticated',
    );
    assert.equal(
        parseSsoFinishResponse({
            success: true,
            data: { outcome: 'authenticated', user, tokens, studentAssurance: null, assuranceStatus: 'unavailable' },
        })?.kind,
        'authenticated',
    );
    // Null assurance with available status can never verify.
    assert.equal(
        parseSsoFinishResponse({
            success: true,
            data: { outcome: 'authenticated', user, tokens, studentAssurance: null, assuranceStatus: 'available' },
        }),
        null,
    );
    // A non-student account can never complete student SSO.
    assert.equal(
        parseSsoFinishResponse({
            success: true,
            data: {
                outcome: 'authenticated',
                user: { ...user, role: 'vendor' },
                tokens,
                studentAssurance: assurance,
                assuranceStatus: 'available',
            },
        }),
        null,
    );
    assert.equal(
        parseSsoFinishResponse({
            success: true,
            data: {
                outcome: 'link_required',
                handoffId: HANDOFF_ID,
                handoffSecret: 'opaque-handoff-secret',
                expiresAt: new Date(Date.now() + 600_000).toISOString(),
            },
        })?.kind,
        'link_required',
    );
    assert.equal(
        parseSsoFinishResponse({
            success: true,
            data: { outcome: 'link_required', handoffId: 'nope', handoffSecret: 's', expiresAt: new Date().toISOString() },
        }),
        null,
    );
    assert.equal(parseSsoFinishResponse({ success: true, data: { outcome: 'restart_required' } }), null);
});

test('restart detection reads only the safe conflict code', () => {
    assert.equal(parseSsoRestart(409, { success: false, error: { code: 'SSO_RESTART_REQUIRED' } }), true);
    assert.equal(parseSsoRestart(409, { success: false, error: { code: 'OTHER' } }), false);
    assert.equal(parseSsoRestart(500, { success: false, error: { code: 'SSO_RESTART_REQUIRED' } }), false);
    assert.equal(parseSsoRestart(409, null), false);
});

test('reauth grant parsing requires a uuid id, opaque secret, and instant expiry', () => {
    const grant = {
        grantId: '60000000-0000-4000-8000-000000000001',
        grantSecret: 'opaque-grant-secret',
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
    assert.deepEqual(parseSsoReauthResponse({ success: true, data: grant }), grant);
    assert.equal(parseSsoReauthResponse({ success: true, data: { ...grant, grantId: 'not-a-uuid' } }), null);
    assert.equal(parseSsoReauthResponse({ success: true, data: { ...grant, grantSecret: '' } }), null);
    assert.equal(parseSsoReauthResponse({ success: true, data: { ...grant, expiresAt: 'yesterday' } }), null);
    assert.equal(parseSsoReauthResponse(null), null);
});

test('link result parsing separates linked, mismatch, and restart', () => {
    assert.deepEqual(
        parseSsoLinkResponse(201, {
            success: true,
            data: { outcome: 'linked', reactivated: false, schoolAssertion: 'recorded' },
        }),
        { kind: 'linked', reactivated: false, schoolAssertion: 'recorded' },
    );
    assert.deepEqual(
        parseSsoLinkResponse(409, { success: false, error: { code: 'SSO_LINK_MISMATCH' } }),
        { kind: 'mismatch' },
    );
    assert.deepEqual(
        parseSsoLinkResponse(409, { success: false, error: { code: 'SSO_RESTART_REQUIRED' } }),
        { kind: 'restart' },
    );
    assert.equal(parseSsoLinkResponse(201, { success: true, data: { outcome: 'linked' } }), null);
    assert.equal(parseSsoLinkResponse(409, { success: false, error: { code: 'OTHER' } }), null);
    assert.equal(parseSsoLinkResponse(500, null), null);
});

test('tab attempt storage round-trips and expires honestly', () => {
    const storage = memoryStorage();
    assert.equal(readSsoAttempt(storage), null);
    const record = {
        attemptId: ATTEMPT_ID,
        finishSecret: 'finish-secret',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        generation: 7,
        returnPath: '/marketplace',
    };
    assert.equal(saveSsoAttempt(storage, record), true);
    assert.deepEqual(readSsoAttempt(storage), record);
    assert.equal(isSsoAttemptLive(record, Date.now()), true);
    assert.equal(isSsoAttemptLive({ ...record, expiresAt: new Date(Date.now() - 1_000).toISOString() }, Date.now()), false);
    assert.equal(ssoAttemptMatches(record, ATTEMPT_ID.toUpperCase(), 7), true);
    assert.equal(ssoAttemptMatches(record, ATTEMPT_ID, 8), false);
    assert.equal(ssoAttemptMatches(record, HANDOFF_ID, 7), false);
    clearSsoAttempt(storage);
    assert.equal(readSsoAttempt(storage), null);
});

test('tab storage failures fail closed without throwing', () => {
    const storage = throwingStorage();
    const record = {
        attemptId: ATTEMPT_ID,
        finishSecret: 'finish-secret',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        generation: 1,
        returnPath: '/marketplace',
    };
    assert.equal(saveSsoAttempt(storage, record), false);
    assert.equal(readSsoAttempt(storage), null);
    assert.equal(saveSsoHandoff(storage, { handoffId: HANDOFF_ID, handoffSecret: 's', expiresAt: record.expiresAt, returnPath: '/marketplace' }), false);
    assert.equal(readSsoHandoff(storage), null);
    clearSsoAttempt(storage);
    clearSsoHandoff(storage);
});

test('handoff storage keeps linking secrets out of URLs', () => {
    const storage = memoryStorage();
    const handoff = { handoffId: HANDOFF_ID, handoffSecret: 'handoff-secret', expiresAt: new Date(Date.now() + 600_000).toISOString(), returnPath: '/marketplace' };
    assert.equal(saveSsoHandoff(storage, handoff), true);
    assert.deepEqual(readSsoHandoff(storage), handoff);
    assert.equal(saveSsoHandoff(storage, { ...handoff, handoffId: 'bad' }), false);
    assert.deepEqual(readSsoHandoff(storage), handoff);
    clearSsoHandoff(storage);
    assert.equal(readSsoHandoff(storage), null);
});

test('handoff storage carries the return path and rejects empties', () => {
    const storage = memoryStorage();
    const handoff = { handoffId: HANDOFF_ID, handoffSecret: 'handoff-secret', expiresAt: new Date(Date.now() + 600_000).toISOString(), returnPath: '/marketplace/deals/p1?claim=1' };
    assert.equal(saveSsoHandoff(storage, handoff), true);
    assert.equal(readSsoHandoff(storage)?.returnPath, '/marketplace/deals/p1?claim=1');
    assert.equal(saveSsoHandoff(storage, { ...handoff, returnPath: '' }), false);
    assert.equal(readSsoHandoff(storage)?.returnPath, '/marketplace/deals/p1?claim=1');
});

test('failure redirects carry a safe error taxonomy only', () => {
    assert.equal(parseLoginErrorCode('sso_expired'), 'sso_expired');
    assert.equal(parseLoginErrorCode('session_expired'), 'session_expired');
    assert.equal(parseLoginErrorCode('sso_not_completed'), 'sso_not_completed');
    assert.equal(parseLoginErrorCode('sso_unavailable'), 'sso_unavailable');
    assert.equal(parseLoginErrorCode('SSO_RESTART_REQUIRED'), null);
    assert.equal(parseLoginErrorCode('sso_expired&attempt=1'), null);
    assert.equal(parseLoginErrorCode(null), null);
    assert.match(loginErrorMessage('sso_expired'), /expired/);
    assert.match(loginErrorMessage('session_expired'), /password/);
    assert.doesNotMatch(loginErrorMessage('sso_not_completed'), /attempt|secret|token/i);
    const path = ssoFailureLoginPath('sso_expired', '/marketplace?claimSession=x', ORIGIN);
    assert.ok(path.startsWith('/auth/student/login?'));
    assert.ok(path.includes('error=sso_expired'));
    assert.ok(!path.includes('ATTEMPT') && !path.includes('secret'));
    // Unsafe return paths fall back instead of redirecting off-origin.
    assert.equal(
        ssoFailureLoginPath('sso_expired', 'https://evil.test/', ORIGIN),
        '/auth/student/login?error=sso_expired&redirect=%2Fmarketplace',
    );
});

test('post-login routing keeps enrollment continuation explicit', () => {
    const verified = {
        schoolAccountStatus: 'verified',
        schoolAccountMethod: 'email_otp',
        schoolAccountValidUntil: null,
        studentStatus: 'verified',
        enrollmentMethod: 'registration',
        studentValidUntil: null,
        reason: null,
    } as const;
    const pending = { ...verified, studentStatus: 'pending', enrollmentMethod: null, reason: 'awaiting_enrollment' } as const;
    assert.equal(
        ssoPostLoginDestination({ studentAssurance: { ...verified }, assuranceStatus: 'available', returnPath: '/marketplace', origin: ORIGIN }),
        '/marketplace',
    );
    assert.equal(
        ssoPostLoginDestination({ studentAssurance: { ...pending }, assuranceStatus: 'available', returnPath: '/marketplace', origin: ORIGIN }),
        '/student/verification',
    );
    for (const studentStatus of ['expired', 'denied', 'revoked', 'inactive'] as const) {
        assert.equal(
            ssoPostLoginDestination({
                studentAssurance: { ...pending, studentStatus },
                assuranceStatus: 'available',
                returnPath: '/marketplace',
                origin: ORIGIN,
            }),
            '/student/verification',
        );
    }
    // Unavailable assurance stays signed in; benefits fail closed server-side.
    assert.equal(
        ssoPostLoginDestination({ studentAssurance: null, assuranceStatus: 'unavailable', returnPath: '/marketplace', origin: ORIGIN }),
        '/marketplace',
    );
});
