export const VERIFICATION_NOTICE_VERSION = '2026-09-05.v1';
/**
 * The only Microsoft notice approved for new issuance. v1/v2 are retained
 * for historical grants, but a legacy institution policy must not mint new
 * attempts because older notices omit the approved retention and
 * withdrawal explanation.
 */
export const MICROSOFT_CURRENT_NOTICE_VERSION = 'microsoft-v3';
export const MERCHANT_DISCLOSURE_NOTICE_VERSION = '2026-09-05.v1';
/** The only Terms of Service version a new student account may accept.
 *  This matches the document's visible version ("Version 1.0") so the
 *  identifier shown at acceptance and stored as evidence can be matched
 *  directly to the published text. */
export const STUDENT_TERMS_VERSION = '1.0';
export const VERIFICATION_NOTICE_TEXT =
    'We use your school email proof to assess student eligibility. You can withdraw verification processing consent.';
export const MERCHANT_DISCLOSURE_NOTICE_TEXT =
    'We share your current eligibility with this merchant for the stated purpose. You can withdraw this disclosure.';
