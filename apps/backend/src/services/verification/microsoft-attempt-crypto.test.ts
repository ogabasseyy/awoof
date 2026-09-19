import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { decryptMicrosoftAttemptVerifier, encryptMicrosoftAttemptVerifier, hashMicrosoftAttemptSecret } from './microsoft-attempt-crypto.js';

test('attempt secrets are one-way hashed and PKCE verifiers require the dedicated authenticated-encryption key', () => {
    const key = randomBytes(32).toString('base64url');
    const verifier = 'A'.repeat(64);
    const encrypted = encryptMicrosoftAttemptVerifier(verifier, key, 'attempt-a');
    assert.notEqual(encrypted, verifier);
    assert.equal(decryptMicrosoftAttemptVerifier(encrypted, key, 'attempt-a'), verifier);
    assert.notEqual(hashMicrosoftAttemptSecret('state'), 'state');
    assert.throws(() => decryptMicrosoftAttemptVerifier(encrypted, randomBytes(32).toString('base64url'), 'attempt-a'));
    assert.throws(() => decryptMicrosoftAttemptVerifier(encrypted, key, 'attempt-b'));
});

test('decrypt rejects truncated IVs and shortened authentication tags', () => {
    const key = randomBytes(32).toString('base64url');
    const encrypted = encryptMicrosoftAttemptVerifier('B'.repeat(64), key, 'attempt-a');
    const [ivText, tagText, ciphertextText] = encrypted.split('.');
    const shortTag = Buffer.from(tagText ?? '', 'base64url').subarray(0, 8).toString('base64url');
    assert.throws(() => decryptMicrosoftAttemptVerifier(`${ivText}.${shortTag}.${ciphertextText}`, key, 'attempt-a'));
    const shortIv = Buffer.from(ivText ?? '', 'base64url').subarray(0, 6).toString('base64url');
    assert.throws(() => decryptMicrosoftAttemptVerifier(`${shortIv}.${tagText}.${ciphertextText}`, key, 'attempt-a'));
});
