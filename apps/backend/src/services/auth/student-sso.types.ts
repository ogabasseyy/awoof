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
};

export type LoginOptions = {
    password: true;
    providers: LoginProvider[];
    registration: true;
    recovery: true;
};
