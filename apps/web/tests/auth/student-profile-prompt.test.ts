import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionSnapshot } from '../../src/lib/student-profile-prompt';
import {
    PROFILE_DEFERRAL_KEY_PREFIX,
    clearDeferral,
    deferKey,
    profilePromptDecision,
    readDeferral,
    resolveStudentPostAuthNavigation,
    subscribeProfileDeferralChanges,
    writeDeferral,
} from '../../src/lib/student-profile-prompt';

const ACCOUNT_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_ACCOUNT_ID = '00000000-0000-4000-8000-000000000002';

function snapshot(sessionId: string | null, generation = 1): SessionSnapshot {
    return {
        generation,
        browserSessionId: sessionId,
        accessToken: sessionId ? `access-${sessionId}` : null,
        refreshToken: sessionId ? `refresh-${sessionId}` : null,
    };
}

function memoryStorage(): Storage {
    const values = new Map<string, string>();
    return {
        get length() { return values.size; },
        clear() { values.clear(); },
        key(index) { return [...values.keys()][index] ?? null; },
        getItem(key) { return values.get(key) ?? null; },
        removeItem(key) { values.delete(key); },
        setItem(key, value) { values.set(key, String(value)); },
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

let uniqueSessionCounter = 0;
function uniqueSessionId(prefix: string): string {
    uniqueSessionCounter += 1;
    return `synthetic-${prefix}-session-${uniqueSessionCounter}`;
}

test('defer keys use the session-namespaced prompt marker format', () => {
    assert.equal(deferKey('browser-session-7'), 'awoof.profile.defer-prompt.v1.browser-session-7');
    assert.equal(PROFILE_DEFERRAL_KEY_PREFIX, 'awoof.profile.defer-prompt.v1.');
});

test('an eligible pending server decision with ordinary marketplace browse routes to completion', () => {
    assert.equal(
        profilePromptDecision({
            promptDecision: 'complete_profile',
            destination: '/marketplace',
            explicitContinuation: false,
            deferred: false,
        }),
        'complete_profile',
    );
});

test('an explicit continuation that resolves exactly to marketplace still permits completion', () => {
    assert.equal(
        profilePromptDecision({
            promptDecision: 'complete_profile',
            destination: '/marketplace',
            explicitContinuation: true,
            deferred: false,
        }),
        'complete_profile',
    );
});

test('ineligible server decisions are never elevated by client-supplied values', () => {
    const scenarios: Array<{ name: string; promptDecision: 'complete_profile' | 'continue' }> = [
        { name: 'verified enrollment', promptDecision: 'continue' },
        { name: 'expired enrollment', promptDecision: 'continue' },
        { name: 'denied enrollment', promptDecision: 'continue' },
        { name: 'revoked enrollment', promptDecision: 'continue' },
        { name: 'unavailable assurance', promptDecision: 'continue' },
        { name: 'verification continuation available', promptDecision: 'continue' },
        { name: 'disabled feature', promptDecision: 'continue' },
    ];
    for (const scenario of scenarios) {
        assert.equal(
            profilePromptDecision({
                promptDecision: scenario.promptDecision,
                destination: '/marketplace',
                explicitContinuation: false,
                deferred: false,
            }),
            'continue',
            scenario.name,
        );
    }
    // Extra fields smuggled alongside the decision change nothing: the client
    // cannot recompute eligibility from feature, status, or provenance inputs.
    const smuggled = {
        promptDecision: 'continue',
        destination: '/marketplace',
        explicitContinuation: false,
        deferred: false,
        featureEnabled: true,
        studentStatus: 'pending',
        attentionFields: ['programme'],
        verificationContinuationAvailable: false,
    } as unknown as Parameters<typeof profilePromptDecision>[0];
    assert.equal(profilePromptDecision(smuggled), 'continue');
});

test('a deferred session continues without re-prompting', () => {
    assert.equal(
        profilePromptDecision({
            promptDecision: 'complete_profile',
            destination: '/marketplace',
            explicitContinuation: false,
            deferred: true,
        }),
        'continue',
    );
});

test('every excluded continuation bypasses completion even when the server offers it', () => {
    const excluded = [
        '/student/verification',
        '/student/verification?method=registration',
        '/student/security',
        '/student/security#recovery-codes',
        '/student/profile',
        '/marketplace/offers/synthetic-offer',
        '/marketplace/checkout',
        '/marketplace/purchase/synthetic-purchase',
        '/student/benefits/claim',
        '/auth/student/sso/onboarding',
        '/consent/synthetic-action',
        '/account/link/synthetic-provider',
    ];
    for (const destination of excluded) {
        assert.equal(
            profilePromptDecision({
                promptDecision: 'complete_profile',
                destination,
                explicitContinuation: true,
                deferred: false,
            }),
            'continue',
            destination,
        );
    }
});

test('near-marketplace destinations do not prompt; only the exact browse path qualifies', () => {
    for (const destination of ['/marketplace/', '/marketplace?from=sso-test', '/marketplace#deals', '/marketplaces', 'marketplace']) {
        assert.equal(
            profilePromptDecision({
                promptDecision: 'complete_profile',
                destination,
                explicitContinuation: false,
                deferred: false,
            }),
            'continue',
            destination,
        );
    }
});

test('completion self-targets never prompt, so routing cannot loop', () => {
    for (const destination of [
        '/student/profile/complete',
        '/student/profile/complete/',
        '/student/profile/complete/extra',
        '/student/profile/complete?redirect=%2Fmarketplace',
        '/student/profile/complete#form',
    ]) {
        assert.equal(
            profilePromptDecision({
                promptDecision: 'complete_profile',
                destination,
                explicitContinuation: true,
                deferred: false,
            }),
            'continue',
            destination,
        );
    }
});

test('unsafe destinations fail closed to continue', () => {
    for (const destination of [
        'https://evil.test/marketplace',
        '//evil.test/marketplace',
        'javascript:alert(1)',
        '',
    ]) {
        assert.equal(
            profilePromptDecision({
                promptDecision: 'complete_profile',
                destination,
                explicitContinuation: false,
                deferred: false,
            }),
            'continue',
            destination === '' ? '(empty)' : destination,
        );
    }
});

test('deferral round-trips for the same session and account only', () => {
    const storage = memoryStorage();
    const sessionId = uniqueSessionId('roundtrip');
    const session = snapshot(sessionId);
    assert.equal(readDeferral(storage, session, ACCOUNT_ID), false);
    writeDeferral(storage, session, ACCOUNT_ID, () => session);
    assert.equal(storage.getItem(deferKey(sessionId)), ACCOUNT_ID);
    assert.equal(readDeferral(storage, session, ACCOUNT_ID), true);
});

test('an account mismatch clears the binding and does not suppress the new account', () => {
    const storage = memoryStorage();
    const sessionId = uniqueSessionId('mismatch');
    const session = snapshot(sessionId);
    writeDeferral(storage, session, ACCOUNT_ID, () => session);
    assert.equal(readDeferral(storage, session, OTHER_ACCOUNT_ID), false);
    assert.equal(storage.getItem(deferKey(sessionId)), null);
});

test('a deferral never leaks across browser sessions', () => {
    const storage = memoryStorage();
    const first = snapshot(uniqueSessionId('first'));
    const second = snapshot(uniqueSessionId('second'));
    writeDeferral(storage, first, ACCOUNT_ID, () => first);
    assert.equal(readDeferral(storage, second, ACCOUNT_ID), false);
    assert.equal(storage.getItem(deferKey(second.browserSessionId!)), null);
    assert.equal(readDeferral(storage, first, ACCOUNT_ID), true);
});

test('missing session or account identifiers disable deferral reads and writes', () => {
    const storage = memoryStorage();
    const signedOut = snapshot(null);
    writeDeferral(storage, signedOut, ACCOUNT_ID, () => signedOut);
    assert.equal(storage.length, 0);
    assert.equal(readDeferral(storage, signedOut, ACCOUNT_ID), false);
    const session = snapshot(uniqueSessionId('no-account'));
    writeDeferral(storage, session, '', () => session);
    assert.equal(storage.length, 0);
    writeDeferral(storage, session, null, () => session);
    assert.equal(storage.length, 0);
    assert.equal(readDeferral(storage, session, null), false);
    clearDeferral(storage, signedOut);
    assert.equal(storage.length, 0);
});

test('a session replacement before the write suppresses the obsolete marker', () => {
    const storage = memoryStorage();
    const obsolete = snapshot(uniqueSessionId('obsolete'));
    const current = snapshot(uniqueSessionId('current'));
    writeDeferral(storage, obsolete, ACCOUNT_ID, () => current);
    assert.equal(storage.getItem(deferKey(obsolete.browserSessionId!)), null);
    assert.equal(storage.length, 0);
});

test('a session replacement during the write removes only the obsolete key', () => {
    const storage = memoryStorage();
    const obsolete = snapshot(uniqueSessionId('obsolete-write'));
    const current = snapshot(uniqueSessionId('current-write'));
    storage.setItem(deferKey(current.browserSessionId!), OTHER_ACCOUNT_ID);
    let calls = 0;
    writeDeferral(storage, obsolete, ACCOUNT_ID, () => {
        calls += 1;
        return calls === 1 ? obsolete : current;
    });
    assert.equal(calls, 2);
    assert.equal(storage.getItem(deferKey(obsolete.browserSessionId!)), null);
    assert.equal(storage.getItem(deferKey(current.browserSessionId!)), OTHER_ACCOUNT_ID);
});

test('a stale old-session logout never removes a newer session marker', () => {
    const storage = memoryStorage();
    const oldSession = snapshot(uniqueSessionId('old'));
    const newSession = snapshot(uniqueSessionId('new'));
    writeDeferral(storage, oldSession, ACCOUNT_ID, () => oldSession);
    writeDeferral(storage, newSession, ACCOUNT_ID, () => newSession);
    clearDeferral(storage, oldSession);
    assert.equal(storage.getItem(deferKey(oldSession.browserSessionId!)), null);
    assert.equal(storage.getItem(deferKey(newSession.browserSessionId!)), ACCOUNT_ID);
    assert.equal(readDeferral(storage, newSession, ACCOUNT_ID), true);
});

test('logout clears the invalidated session marker without touching others', () => {
    const storage = memoryStorage();
    const session = snapshot(uniqueSessionId('logout'));
    writeDeferral(storage, session, ACCOUNT_ID, () => session);
    clearDeferral(storage, session);
    assert.equal(readDeferral(storage, session, ACCOUNT_ID), false);
    assert.equal(storage.length, 0);
});

test('unavailable storage falls back to an in-memory marker scoped to the session', () => {
    const session = snapshot(uniqueSessionId('memory'));
    const other = snapshot(uniqueSessionId('memory-other'));
    assert.equal(readDeferral(null, session, ACCOUNT_ID), false);
    writeDeferral(null, session, ACCOUNT_ID, () => session);
    assert.equal(readDeferral(null, session, ACCOUNT_ID), true);
    assert.equal(readDeferral(null, other, ACCOUNT_ID), false);
    assert.equal(readDeferral(null, session, OTHER_ACCOUNT_ID), false);
    writeDeferral(null, session, ACCOUNT_ID, () => session);
    clearDeferral(null, session);
    assert.equal(readDeferral(null, session, ACCOUNT_ID), false);
});

test('throwing storage never breaks deferral reads, writes, or clears', () => {
    const storage = throwingStorage();
    const session = snapshot(uniqueSessionId('throwing'));
    assert.equal(readDeferral(storage, session, ACCOUNT_ID), false);
    writeDeferral(storage, session, ACCOUNT_ID, () => session);
    assert.equal(readDeferral(storage, session, ACCOUNT_ID), true);
    clearDeferral(storage, session);
    assert.equal(readDeferral(storage, session, ACCOUNT_ID), false);
});

test('a throwing snapshot reader fails closed without writing', () => {
    const storage = memoryStorage();
    const session = snapshot(uniqueSessionId('reader-throws'));
    writeDeferral(storage, session, ACCOUNT_ID, () => { throw new Error('denied'); });
    assert.equal(storage.length, 0);
    assert.equal(readDeferral(storage, session, ACCOUNT_ID), false);
});

type FakeWindow = {
    listeners: Map<string, Set<(event: unknown) => void>>;
    addEventListener(type: string, listener: (event: unknown) => void): void;
    removeEventListener(type: string, listener: (event: unknown) => void): void;
    dispatch(type: string, event: unknown): void;
};

function installFakeWindow(): FakeWindow {
    const listeners = new Map<string, Set<(event: unknown) => void>>();
    const fake: FakeWindow = {
        listeners,
        addEventListener(type, listener) {
            const set = listeners.get(type) ?? new Set();
            set.add(listener);
            listeners.set(type, set);
        },
        removeEventListener(type, listener) {
            listeners.get(type)?.delete(listener);
        },
        dispatch(type, event) {
            for (const listener of listeners.get(type) ?? []) listener(event);
        },
    };
    (globalThis as { window?: unknown }).window = fake;
    return fake;
}

function removeFakeWindow(): void {
    delete (globalThis as { window?: unknown }).window;
}

test('a same-session deferral storage event notifies with its deferred state', () => {
    const fake = installFakeWindow();
    try {
        const sessionId = uniqueSessionId('event');
        const session = snapshot(sessionId);
        const seen: Array<{ sessionId: string; deferred: boolean }> = [];
        const unsubscribe = subscribeProfileDeferralChanges((change) => { seen.push(change); }, () => session);
        try {
            fake.dispatch('storage', { type: 'storage', key: deferKey(sessionId), newValue: ACCOUNT_ID });
            fake.dispatch('storage', { type: 'storage', key: deferKey(sessionId), newValue: null });
            assert.deepEqual(seen, [
                { sessionId, deferred: true },
                { sessionId, deferred: false },
            ]);
        } finally {
            unsubscribe();
        }
    } finally {
        removeFakeWindow();
    }
});

test('deferral events ignore other sessions, auth keys, and unrelated events', () => {
    const fake = installFakeWindow();
    try {
        const session = snapshot(uniqueSessionId('event-active'));
        const seen: unknown[] = [];
        const unsubscribe = subscribeProfileDeferralChanges((change) => { seen.push(change); }, () => session);
        try {
            fake.dispatch('storage', { type: 'storage', key: deferKey(uniqueSessionId('event-other')), newValue: ACCOUNT_ID });
            fake.dispatch('storage', { type: 'storage', key: 'awoof.session.v1', newValue: '{}' });
            fake.dispatch('storage', { type: 'storage', key: null, newValue: null });
            fake.dispatch('storage', { type: 'storage', key: 'awoof.profile.defer-prompt.v1.', newValue: ACCOUNT_ID });
            fake.dispatch('click', { type: 'click' });
            assert.deepEqual(seen, []);
            assert.equal(fake.listeners.get('storage')?.size, 1);
        } finally {
            unsubscribe();
        }
        assert.equal(fake.listeners.get('storage')?.size ?? 0, 0);
    } finally {
        removeFakeWindow();
    }
});

test('deferral subscription without a browser window is a silent no-op', () => {
    removeFakeWindow();
    const session = snapshot(uniqueSessionId('no-window'));
    const unsubscribe = subscribeProfileDeferralChanges(() => { throw new Error('must not notify'); }, () => session);
    assert.doesNotThrow(() => unsubscribe());
});

test('post-auth navigation skips the projection read for explicit continuations', async () => {
    const session = snapshot(uniqueSessionId('skip-fetch'));
    let reads = 0;
    const destination = await resolveStudentPostAuthNavigation({
        accountId: ACCOUNT_ID,
        sessionSnapshot: session,
        safeDestination: '/student/verification',
        explicitContinuation: true,
        storage: memoryStorage(),
        readProjection: async () => { reads += 1; return { promptDecision: 'complete_profile' }; },
        readActiveSnapshot: () => session,
    });
    assert.equal(destination, '/student/verification');
    assert.equal(reads, 0);
});

test('post-auth navigation routes eligible marketplace browse to the completion screen', async () => {
    const storage = memoryStorage();
    const session = snapshot(uniqueSessionId('nav-eligible'));
    const destination = await resolveStudentPostAuthNavigation({
        accountId: ACCOUNT_ID,
        sessionSnapshot: session,
        safeDestination: '/marketplace',
        explicitContinuation: false,
        storage,
        readProjection: async () => ({ promptDecision: 'complete_profile' }),
        readActiveSnapshot: () => session,
    });
    assert.equal(destination, '/student/profile/complete?redirect=%2Fmarketplace');
});

test('post-auth navigation fails open to the safe destination', async () => {
    const storage = memoryStorage();
    const session = snapshot(uniqueSessionId('nav-fail-open'));
    const failing: Array<{ name: string; readProjection: () => Promise<{ promptDecision: 'complete_profile' | 'continue' }> }> = [
        { name: 'transport failure', readProjection: async () => { throw new Error('down'); } },
        { name: 'malformed decision', readProjection: async () => ({ promptDecision: 'verified' as unknown as 'continue' }) },
    ];
    for (const scenario of failing) {
        const destination = await resolveStudentPostAuthNavigation({
            accountId: ACCOUNT_ID,
            sessionSnapshot: session,
            safeDestination: '/marketplace',
            explicitContinuation: false,
            storage,
            readProjection: scenario.readProjection,
            readActiveSnapshot: () => session,
        });
        assert.equal(destination, '/marketplace', scenario.name);
    }
});

test('post-auth navigation fails open when the projection read hangs', async () => {
    const storage = memoryStorage();
    const session = snapshot(uniqueSessionId('nav-hung-read'));
    const destination = await resolveStudentPostAuthNavigation({
        accountId: ACCOUNT_ID,
        sessionSnapshot: session,
        safeDestination: '/marketplace',
        explicitContinuation: false,
        storage,
        readProjection: () => new Promise<{ promptDecision: 'complete_profile' | 'continue' }>(() => undefined),
        readActiveSnapshot: () => session,
        projectionTimeoutMs: 20,
    });
    assert.equal(destination, '/marketplace');
});

test('post-auth navigation honors deferral and session replacement without prompting', async () => {
    const storage = memoryStorage();
    const session = snapshot(uniqueSessionId('nav-deferred'));
    writeDeferral(storage, session, ACCOUNT_ID, () => session);
    const deferred = await resolveStudentPostAuthNavigation({
        accountId: ACCOUNT_ID,
        sessionSnapshot: session,
        safeDestination: '/marketplace',
        explicitContinuation: false,
        storage,
        readProjection: async () => ({ promptDecision: 'complete_profile' }),
        readActiveSnapshot: () => session,
    });
    assert.equal(deferred, '/marketplace');

    const replaced = snapshot(uniqueSessionId('nav-replaced'));
    const afterSwitch = await resolveStudentPostAuthNavigation({
        accountId: ACCOUNT_ID,
        sessionSnapshot: session,
        safeDestination: '/marketplace',
        explicitContinuation: false,
        storage: memoryStorage(),
        readProjection: async () => ({ promptDecision: 'complete_profile' }),
        readActiveSnapshot: () => replaced,
    });
    assert.equal(afterSwitch, '/marketplace');
});

test('post-auth navigation never prompts without a committed browser session', async () => {
    const signedOut = snapshot(null);
    let reads = 0;
    const destination = await resolveStudentPostAuthNavigation({
        accountId: ACCOUNT_ID,
        sessionSnapshot: signedOut,
        safeDestination: '/marketplace',
        explicitContinuation: false,
        storage: memoryStorage(),
        readProjection: async () => { reads += 1; return { promptDecision: 'complete_profile' }; },
        readActiveSnapshot: () => signedOut,
    });
    assert.equal(destination, '/marketplace');
    assert.equal(reads, 0);
});
