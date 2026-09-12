import type { MicrosoftConsentSnapshot, MicrosoftIdentity, MicrosoftPolicy } from './microsoft.types.js';

export function allowsTenant(policy: MicrosoftPolicy, identity: MicrosoftIdentity, now: Date): boolean {
    return policy.enabled && policy.approvedUntil > now && policy.tenantId === identity.tenantId;
}

export function sameConsentSnapshot(a: MicrosoftConsentSnapshot, b: MicrosoftConsentSnapshot): boolean {
    return a.universityId === b.universityId
        && a.providerPolicyVersion === b.providerPolicyVersion
        && a.noticeVersion === b.noticeVersion
        && a.mode === b.mode
        && a.scopes.length === b.scopes.length
        && a.scopes.every((scope, index) => scope === b.scopes[index]);
}
