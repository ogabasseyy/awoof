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

## Rendered defects observed during browser-session validation

On the unchanged application tree at `af8cd68349530d6a489776a990ef569f2558898a`, the production-built auth suite passed 17/17 after harness corrections. The extra development-mode run passed 14/17: legacy profile initialization, cross-tab logout and account replacement all encountered the same React diagnostic about a button nested inside another button. Root confirmed the dark-mode toggle at `apps/web/src/app/student/profile/page.tsx:135` is placed inside the non-link row button at line 173. This is a real pre-existing markup defect, not an authentication-fixture failure. A bounded repair should render one interactive control for that row, preserve accessible naming/state and keyboard operation, and exercise the existing profile/logout flows; do not suppress the console diagnostic or redesign the profile as part of that small correction. The current harness branch does not implement that repair.

Desktop/mobile marketplace screenshots also still display the legacy "verified" wording from `verificationStatus`; the consumer repair must include that assurance display, not just the profile badge. The mobile marketplace hides its QR image but retains a scan prompt, a separate lower-priority existing visual inconsistency. Neither screenshot proves effective student eligibility or merchant integration. The owner's public existing Google font build-fetch permission supersedes the older offline-only note above; no typography change or real business API use was made.
