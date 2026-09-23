/**
 * Student SSO transport types (Task B1).
 *
 * These describe the browser/provider boundary only and are intentionally
 * separate from persistence shapes. School-account assurance and enrollment
 * eligibility stay separate in every response built from these types.
 */

export type LoginProvider = 'google' | 'microsoft';

export type ProviderObservation = {
    provider: LoginProvider;
    issuer: string;
    subject: string;
    email: string | null;
    mailboxVerified: boolean;
    realm: string;
    schoolMembershipAttested: boolean;
    /**
     * Microsoft directory object id (oid claim) for the returned identity,
     * null for Google. The identity row key stays `subject`; this binds
     * membership evidence to the exact identity that signed in.
     */
    objectId: string | null;
};

export type LoginOptions = {
    password: true;
    providers: LoginProvider[];
    registration: true;
    recovery: true;
};

/** An approved institution login policy with its pinned trust data (moved from the B3 flow module so link code shares it). */
export type ApprovedLoginPolicy = {
    id: string;
    universityId: string;
    provider: LoginProvider;
    issuer: string;
    realm: string;
    version: number;
};

/** Institution SSO login adapter boundary (Task B2). Browser tab secrets stay with the B3 flow; adapters only observe. */
export interface StudentOidcAdapter {
    authorize(input: { state: string; nonce: string; verifier: string; loginHint: string }): Promise<URL>;
    redeem(input: { callback: URL; state: string; nonce: string; verifier: string }): Promise<ProviderObservation>;
}
