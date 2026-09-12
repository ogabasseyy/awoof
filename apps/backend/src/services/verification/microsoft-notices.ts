export const MICROSOFT_NOTICE_COPIES = {
    'microsoft-v1': 'We use Microsoft school identity information to assess student eligibility. You can withdraw Microsoft provider consent.',
    'microsoft-v2': 'We use Microsoft school identity and, where approved, enrollment information to assess student eligibility. You can withdraw Microsoft provider consent.',
} as const;

export type MicrosoftNoticeVersion = keyof typeof MICROSOFT_NOTICE_COPIES;

export function isPublishedMicrosoftNoticeVersion(version: string): version is MicrosoftNoticeVersion {
    return Object.hasOwn(MICROSOFT_NOTICE_COPIES, version);
}
