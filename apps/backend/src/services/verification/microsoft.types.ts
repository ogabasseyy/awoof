export type MicrosoftPolicy = {
    universityId: string;
    tenantId: string;
    version: number;
    enabled: boolean;
    mode: 'identity_only' | 'graph_enrollment';
    approvedUntil: Date;
    termEndsAt: Date | null;
    maxEvidenceHours: number;
};

export type MicrosoftIdentity = { tenantId: string; objectId: string };

export type MicrosoftConsentSnapshot = {
    universityId: string;
    providerPolicyVersion: number;
    noticeVersion: string;
    mode: 'identity_only' | 'graph_enrollment';
    scopes: string[];
};

export type AcceptMicrosoftConsent = {
    processingGrantId: string;
    snapshot: MicrosoftConsentSnapshot;
    accepted: true;
};

export type MicrosoftConsentCopy = {
    /** Immutable text for the exact published notice version in the snapshot. */
    text: string;
};

export type MicrosoftConsentNotice = {
    snapshot: MicrosoftConsentSnapshot;
    copy: MicrosoftConsentCopy;
};

export type MicrosoftConsentHistoryItem = {
    id: string;
    snapshot: MicrosoftConsentSnapshot;
    acceptedAt: Date;
    withdrawnAt: Date | null;
};
