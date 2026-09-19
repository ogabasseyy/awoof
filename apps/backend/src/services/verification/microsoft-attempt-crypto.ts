import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';

function keyFrom(value: string): Buffer {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError('Microsoft attempt encryption key is invalid');
    const key = Buffer.from(value, 'base64url');
    if (key.byteLength !== 32) throw new TypeError('Microsoft attempt encryption key must be 32 bytes');
    return key;
}

/** Safe readiness check; encryption/decryption still validate again at use. */
export function hasValidMicrosoftAttemptEncryptionKey(value: unknown): value is string {
    try { keyFrom(value as string); return true; } catch { return false; }
}

export function hashMicrosoftAttemptSecret(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('base64url');
}

/** Encrypt only the transient PKCE verifier. This key is deliberately not a JWT key. */
export function encryptMicrosoftAttemptVerifier(verifier: string, keyMaterial: string, attemptId: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, keyFrom(keyMaterial), iv);
    cipher.setAAD(Buffer.from(attemptId, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(verifier, 'utf8'), cipher.final()]);
    return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptMicrosoftAttemptVerifier(encoded: string, keyMaterial: string, attemptId: string): string {
    const [ivText, tagText, ciphertextText, extra] = encoded.split('.');
    if (!ivText || !tagText || !ciphertextText || extra) throw new TypeError('Encrypted Microsoft verifier is invalid');
    const iv = Buffer.from(ivText, 'base64url');
    const tag = Buffer.from(tagText, 'base64url');
    if (iv.byteLength !== 12 || tag.byteLength !== 16) throw new TypeError('Encrypted Microsoft verifier is invalid');
    const decipher = createDecipheriv(ALGORITHM, keyFrom(keyMaterial), iv, { authTagLength: 16 });
    decipher.setAAD(Buffer.from(attemptId, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(ciphertextText, 'base64url')), decipher.final()]).toString('utf8');
}
