import assert from 'node:assert/strict';
import test from 'node:test';
import {
    beginClaim,
    beginLoading,
    failClaim,
    markReady,
    parseMerchantHandoffUrl,
    requireEnrollmentVerification,
    resetClaim,
    retryClaim,
    startRedirect,
    type ClaimState,
} from '../../src/lib/student-benefit-claim';

function idle(): ClaimState {
    return { step: 'idle', sessionId: null, error: null, verifyReturnPath: null, attempt: 0 };
}

test('loading starts only from idle and records the claim session', () => {
    const next = beginLoading(idle(), 'session-1');
    assert.equal(next.step, 'loading');
    assert.equal(next.sessionId, 'session-1');
    assert.equal(next.attempt, 0);
    assert.equal(beginLoading(next, 'session-2').sessionId, 'session-1');
});

test('ready carries the reviewed claim summary and clears errors', () => {
    const failed = failClaim(beginClaim(markReady(beginLoading(idle(), 's'), {
        vendorName: 'Vendor', productName: 'Deal', studentPrice: '80.00',
    })), 'boom');
    assert.equal(failed.step, 'error');
    const next = markReady(beginLoading(idle(), 's'), {
        vendorName: 'Vendor', productName: 'Deal', studentPrice: '80.00',
    });
    assert.equal(next.step, 'ready');
    assert.equal(next.error, null);
    assert.equal(next.summary?.productName, 'Deal');
});

test('claiming requires a reviewed ready state and counts attempts', () => {
    assert.equal(beginClaim(idle()).step, 'idle');
    const ready = markReady(beginLoading(idle(), 's'), {
        vendorName: 'Vendor', productName: 'Deal', studentPrice: '80.00',
    });
    const claiming = beginClaim(ready);
    assert.equal(claiming.step, 'claiming');
    assert.equal(claiming.attempt, 1);
    assert.equal(beginClaim(claiming).attempt, 1);
});

test('enrollment failures route to explicit verification without auto-submit', () => {
    const claiming = beginClaim(markReady(beginLoading(idle(), 's'), {
        vendorName: 'V', productName: 'P', studentPrice: '1.00',
    }));
    const next = requireEnrollmentVerification(claiming, '/marketplace/p?claimSession=s');
    assert.equal(next.step, 'verify_required');
    assert.equal(next.verifyReturnPath, '/marketplace/p?claimSession=s');
    assert.equal(next.attempt, 1);
    // Returning from verification never resumes the claim by itself.
    assert.equal(requireEnrollmentVerification(next, '/marketplace/p').step, 'verify_required');
});

test('retry returns to ready for an explicit second attempt, never to claiming', () => {
    const verifying = requireEnrollmentVerification(beginClaim(markReady(beginLoading(idle(), 's'), {
        vendorName: 'V', productName: 'P', studentPrice: '1.00',
    })), '/marketplace/p');
    const retried = retryClaim(verifying);
    assert.equal(retried.step, 'ready');
    assert.equal(retried.attempt, 1);
    const failed = failClaim(beginClaim(markReady(beginLoading(idle(), 's'), {
        vendorName: 'V', productName: 'P', studentPrice: '1.00',
    })), 'network');
    assert.equal(retryClaim(failed).step, 'ready');
    assert.equal(retryClaim(idle()).step, 'idle');
});

test('redirect starts only from a successful claim and reset returns to idle', () => {
    const claiming = beginClaim(markReady(beginLoading(idle(), 's'), {
        vendorName: 'V', productName: 'P', studentPrice: '1.00',
    }));
    assert.equal(startRedirect(idle(), 'https://merchant.example/awoof/student-claim?assertion=X').step, 'idle');
    const redirecting = startRedirect(claiming, 'https://merchant.example/awoof/student-claim?assertion=X');
    assert.equal(redirecting.step, 'redirecting');
    assert.equal(resetClaim(redirecting).step, 'idle');
    assert.equal(resetClaim(redirecting).sessionId, null);
});

test('handoff URLs must use the fixed merchant path with only an opaque assertion', () => {
    const code = 'A'.repeat(43);
    assert.equal(
        parseMerchantHandoffUrl(`https://merchant.example/awoof/student-claim?assertion=${code}`),
        `https://merchant.example/awoof/student-claim?assertion=${code}`,
    );
    // Local development stub over loopback HTTP is accepted.
    assert.equal(
        parseMerchantHandoffUrl(`http://127.0.0.1:4312/awoof/student-claim?assertion=${code}`),
        `http://127.0.0.1:4312/awoof/student-claim?assertion=${code}`,
    );
    for (const bad of [
        `http://merchant.example/awoof/student-claim?assertion=${code}`,
        `https://merchant.example/other/path?assertion=${code}`,
        `https://merchant.example/awoof/student-claim?assertion=${code}&email=a@b.test`,
        `https://merchant.example/awoof/student-claim?code=${code}`,
        `https://merchant.example/awoof/student-claim?assertion=short`,
        `https://user:pass@merchant.example/awoof/student-claim?assertion=${code}`,
        `https://merchant.example/awoof/student-claim?assertion=${code}#fragment`,
        'not-a-url',
        '',
    ]) {
        assert.equal(parseMerchantHandoffUrl(bad), null, bad);
    }
});

test('handoff URLs can be pinned to the reviewed merchant origin', () => {
    const code = 'B'.repeat(43);
    assert.equal(
        parseMerchantHandoffUrl(
            `https://merchant.example/awoof/student-claim?assertion=${code}`,
            'https://merchant.example',
        ),
        `https://merchant.example/awoof/student-claim?assertion=${code}`,
    );
    assert.equal(
        parseMerchantHandoffUrl(
            `https://evil.example/awoof/student-claim?assertion=${code}`,
            'https://merchant.example',
        ),
        null,
    );
});
