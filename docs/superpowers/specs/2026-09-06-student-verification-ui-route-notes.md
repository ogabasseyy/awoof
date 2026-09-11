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

## Refreshed producer/consumer map,2026-09-07

Read-only preparation at accepted source9c8fab2611ee3524430cd268be3294bc86c2caee in `/Users/mac/Downloads/Awoof/.worktrees/browser-harness-fix4`. The profile markup/cleanup and shared session/picker/action-marker prerequisites are now accepted; the historical nested-button/setup observations above are not current defects to fix again. Student signup Task1 is a separate exclusive Terra implementation under `2026-09-07-student-signup-flow.md`; no own-status source change or validation is claimed here.

The authoritative route remains authenticated GET `/verification/status`, not the retired `/status/:studentId`, which returns410. `verification.controller.ts` takes identity only from AuthRequest and returns the status service result in the normal success envelope. `verification-flow.service.ts` returns server email, canonical universityId, eligibility, separate verification/merchant notices and optional incomplete_profile guidance. Missing student profile is a valid live-student recovery state with universityId:null and unverified, not a new account or fabricated enrollment. Inactive contexts can still obtain factual status; deleted/non-student accounts cannot use that recovery path.

Exact eligibility union in `eligibility.types.ts`: false reasons are unverified, expired, inactive, policy_changed, identity_changed, consent_required, enrollment_denied. True includes studentId/universityId/evidenceId/processingGrantId/method/verifiedAt/expiresAt; method is student_email or enrollment. Dates serialize as strings at HTTP. A future web parser must validate this discriminant and fields from unknown data, with explicit unknown/unavailable presentation on malformed responses, not fallback to auth user.verificationStatus. IDs are internal own-account controls, not merchant callback claims or visible assurance labels.

Remaining concrete web consumers found in source:

| Source | Current behavior | Follow-on responsibility |
| --- | --- | --- |
| apps/web/src/app/student/profile/page.tsx:78 | isVerified reads legacy user.verificationStatus | Use authenticated own-status display and discoverable Student verification link, retain accepted native switch |
| apps/web/src/app/marketplace/page.tsx:86 | Same legacy flag drives ready/verify guidance | Use current status for assurance wording and recovery link; a catalog listing is not discount authorization |
| apps/web/src/app/marketplace/[id]/page.tsx:99 | Legacy flag gates the Buy path | Track separately with benefit/merchant authorization; changing client UI alone cannot repair server redemption integrity or authorize Paystack work |

`student/layout.tsx` only provides font/layout, not an authentication gate. The new `/student/verification` consumer must therefore explicitly use current AuthProvider state and authenticated API, with operation/current-session guards and a sanitized login return; do not infer route protection merely from its directory name. `/student/dashboard` remains its existing redirect, with no new dashboard design.

The public methods producer reports actual configured availability and reasons. Email requires active institution, at least one active approved student domain and configured email transport. Registration requires normalization policy and a valid single configured adapter. Portal and WhatsApp remain unavailable. Those institution-level availability results do not prove the current mailbox matches policy; the authenticated flow/server rechecks it. A future UI must not offer personal-email/WhatsApp/portal workarounds or present an adapter existence as completed verification.

Additional exact consumer consequence: signup confirmation returns completion.user plus its separate eligibility, whereas ordinary auth responses still expose historical verificationStatus. A successful new proof flow must not be patched by setting that legacy flag client-side just to make the marketplace say ready. Its current empty-catalog copy still promises Verify once, and its Finish verification link goes to the profile hub rather than an implemented verification screen. The own-status UI task must fix that wording/link using the approved periodic model. Product-detail external-voucher/vendor-website navigation currently occurs before login/legacy verification checks; that outbound navigation is not merchant discount authorization. Keep it on the merchant/reference-connector migration scope and do not portray the signup repair as completing voucher enforcement.

## Consent withdrawal discoverability gap to resolve before UI dispatch

The current status endpoint exposes processingGrantId only inside eligible:true. Expired, inactive, policy-changed, identity-changed and other false results omit it; a fresh page cannot discover an existing processing consent merely from its authenticated status. A just-initiated grant may be held locally in memory, but that is not persistent consent-management discovery. Existing DELETE `/verification/consents/:id` correctly supports own historical/inactive-subject withdrawal through `eligibility-consent.service.ts`, with ownership recheck and ordered locks; it must not be weakened to fix UI discovery.

Before promising withdrawal from every relevant status, prepare a bounded own-account read contract exposing withdrawable processing grants independently of eligibility, or another explicitly reviewed discovery mechanism. It must identify the authenticated subject only, expose minimal grant/institution/notice metadata, include historical/inactive grants, and require no new consent just to discover or withdraw old consent. No localStorage cache of grant IDs, inferred IDs or create-to-withdraw workaround. Merchant-disclosure management remains separately scoped unless its own task deliberately adds that UI. This is an integration gap found through code inspection, not a new backend implementation or accepted endpoint design.

Required future evidence must include expired/legacy/inactive states after a reload, current grant and historical grant withdrawal, failed/lost withdrawal response with authoritative reread, account replacement during status/request/confirm/withdraw, and assurance display after expiry. Existing lower-level SQL authority tests establish service behavior only; they do not prove discoverability or these rendered paths. No new backend/browser process or provider request ran for this preparation.

## Authenticated consumer ownership preparation

Read-only check while signup correction round1 owns unrelated source files: accepted `auth.ts:348` exposes `isCurrentSession(candidate)`, which fresh-reconciles storage and requires an active, non-quarantined matching logical generation. `isExactSession` additionally compares the token pair and is deliberately used for refresh commits/terminal cleanup. A future authenticated own-status/request/confirmation/withdrawal consumer must preserve that distinction: a legitimate same-session token rotation is not an account replacement, but login/logout/replacement and quarantine invalidate the operation. Do not compare only userId or decode a JWT to infer current account authority.

The existing authenticated API client already fences retries to its initiating logical session. The future UI still needs its own mounted/abort/attempt checks for local state and a fresh logical-session check before publishing status or navigation. Store no verification credentials or consent IDs in navigation/storage as a substitute. Capture/reconcile before allocating an operation where reconciliation may synchronously notify. New flows must not mutate AuthProvider's private counters or redefine the accepted storage protocol.

Rendering and subscription design remains an explicit planning item: AuthProvider clears user during session reconciliation, so the screen must not keep displaying a prior account's assurance while a replacement account is loading. A future external-store adapter must expose stable cached snapshots/primitives, not allocate a new object on every useSyncExternalStore read; do not introduce render-time reconciliation that synchronously updates unrelated components. Required tests include same-session refresh success, same-user new-login generation, another account arriving mid-operation, and unavailable/quarantined state. These are implementation requirements to resolve in the future own-status plan, not a new hook or tested UI result.
