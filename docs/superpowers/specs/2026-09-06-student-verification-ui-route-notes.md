# Student verification UI route preparation

Source-grounded routing preparation on 2026-09-06 at c075f12, not an implementation or browser-tested result. The approved verification-core design remains the authority.

## Smallest discoverable path

Retain `/student/dashboard` as its existing marketplace redirect. Add the future own-account verification screen at `/student/verification`, reached from a clearly labelled Student verification item in the existing `/student/profile` account hub. The marketplace already links to that hub through `components/student/StudentHeaderActions.tsx`; no new dashboard or navigation framework is needed.

The existing account hub computes `isVerified` from `user.verificationStatus`, which is legacy display data rather than effective eligibility. When the new verification consumer is implemented, the hub's student-assurance badge must use the authenticated own-status endpoint, with explicit unknown/loading/unavailable states. A failed status read must not fall back to that flag. This work is separate from the shared AuthProvider's account authentication state.

## Producer contract

`GET /api/verification/status` returns data `{email,universityId,eligibility,notices,guidance?}`. Notices have separate verification and merchantDisclosure version/text. Eligible data includes method, verifiedAt/expiresAt and internal evidence/grant IDs; show only relevant assurance/timestamps to the account owner. False reasons include unverified, expired, inactive, policy_changed, identity_changed, consent_required and enrollment_denied. `guidance:'incomplete_profile'` is actionable unavailability, not a reason to invent an enrollment result.

The account UI displays the signed-in email and first-line approved-domain OTP. Starting verification uses institution plus a fresh current-version affirmative processing grant; requesting uses that grant ID, confirmation uses the returned challenge ID and OTP, and neither endpoint returns a login session. The status endpoint is authoritative on return and refresh. Do not render all successful HTTP responses as verified.

No merchant-disclosure checkbox, merchant callback or widget assertion is created by this general account screen. Those require the separate merchant-context flow. Enrollment-provider UI is not advertised merely because an adapter exists: institution configuration and available methods must be real. Unsupported domains and incomplete legacy profiles receive support/unavailable guidance, never personal-email or registration-number workarounds.

## Validation and dependencies

Shared browser-session and signup consumers must pass their own reviews first. Test profile navigation, legacy-verified-but-no-evidence, expiry/policy/consent denial, successful OTP, status outage, account switching mid-request, withdrawal and keyboard/mobile controls using local synthetic fixtures. No current assurance can be inferred from a screenshot or JWT. Exact receipt/error UI and safe return context need an executable plan after the shared interfaces are final.

Existing `student/layout.tsx` also uses next/font/google; browser interception does not contain its build-time fetches. Keep the same typography and record offline-build limitations rather than silently reaching external services.
