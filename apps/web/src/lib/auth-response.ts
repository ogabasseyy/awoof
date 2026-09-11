import type { TokenPair, User } from './auth';

export type AuthenticationResponse = {
    user: User;
    tokens: TokenPair;
    requiresEmailVerification: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function isRole(value: unknown): value is User['role'] {
    return value === 'student' || value === 'vendor' || value === 'admin';
}

function isUser(value: unknown): value is User {
    const user = asRecord(value);
    return !!user
        && typeof user.id === 'string'
        && user.id.length > 0
        && typeof user.email === 'string'
        && user.email.length > 0
        && isRole(user.role)
        && (user.verificationStatus === undefined
            || user.verificationStatus === 'unverified'
            || user.verificationStatus === 'verified'
            || user.verificationStatus === 'expired');
}

function isTokenPair(value: unknown): value is TokenPair {
    const tokens = asRecord(value);
    return !!tokens
        && typeof tokens.accessToken === 'string'
        && tokens.accessToken.length > 0
        && typeof tokens.refreshToken === 'string'
        && tokens.refreshToken.length > 0;
}

/** Validate the server's `{ success, data: { user, tokens } }` response. */
export function parseAuthenticationResponse(value: unknown): AuthenticationResponse | null {
    const payload = asRecord(asRecord(value)?.data);
    if (!payload || !isUser(payload.user) || !isTokenPair(payload.tokens)) return null;
    return {
        user: payload.user,
        tokens: payload.tokens,
        requiresEmailVerification: payload.requiresEmailVerification === true,
    };
}

/** Validate `/auth/me`, whose current user is the response's inner `data`. */
export function parseCurrentAccountResponse(value: unknown): User | null {
    const account = asRecord(value)?.data;
    return isUser(account) ? account : null;
}
