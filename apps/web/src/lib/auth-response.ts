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

/**
 * Narrowly validate the optional stored profile name. Returns undefined when
 * the server omits the profile, a stripped `{ name? }` object when present,
 * and null when the shape is malformed.
 */
function toProfile(value: unknown): { name?: string } | undefined | null {
    if (value === undefined) return undefined;
    const profile = asRecord(value);
    if (!profile) return null;
    if (profile.name !== undefined && typeof profile.name !== 'string') return null;
    return typeof profile.name === 'string' ? { name: profile.name } : {};
}

function toUser(value: unknown): User | null {
    const user = asRecord(value);
    if (!user
        || typeof user.id !== 'string'
        || user.id.length === 0
        || typeof user.email !== 'string'
        || user.email.length === 0
        || !isRole(user.role)) return null;
    if (user.verificationStatus !== undefined
        && user.verificationStatus !== 'unverified'
        && user.verificationStatus !== 'verified'
        && user.verificationStatus !== 'expired') return null;
    if (user.recoveryReenrollmentRequired !== undefined
        && typeof user.recoveryReenrollmentRequired !== 'boolean') return null;
    const profile = toProfile(user.profile);
    if (profile === null) return null;
    const parsed: User = { id: user.id, email: user.email, role: user.role };
    if (user.verificationStatus === 'unverified'
        || user.verificationStatus === 'verified'
        || user.verificationStatus === 'expired') {
        parsed.verificationStatus = user.verificationStatus;
    }
    if (typeof user.recoveryReenrollmentRequired === 'boolean') {
        parsed.recoveryReenrollmentRequired = user.recoveryReenrollmentRequired;
    }
    if (profile !== undefined) parsed.profile = profile;
    return parsed;
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
    if (!payload || !isTokenPair(payload.tokens)) return null;
    const user = toUser(payload.user);
    if (!user) return null;
    return {
        user,
        tokens: payload.tokens,
        requiresEmailVerification: payload.requiresEmailVerification === true,
    };
}

/** Validate `/auth/me`, whose current user is the response's inner `data`. */
export function parseCurrentAccountResponse(value: unknown): User | null {
    return toUser(asRecord(value)?.data);
}
