# Verification core remediation design

Status: owner approved the design and proposed defaults on 2026-09-05. Astra's engineering-contract corrections are incorporated below; core implementation remains pending.

## Intent and approved direction

Awoof verifies students for merchants' existing discount systems. Keep the existing TypeScript/Next/Express/PostgreSQL stack. The owner has approved student-email OTP as the first-line method for approved student-email domains, with periodic re-verification and stronger evidence when email rules are insufficient. Authentication, student assurance, and merchant permission are separate.

Three approaches were considered:

1. Recommended: repair the existing application around explicit evidence and merchant permission, reusing the UI and widget.
2. Add more checks to the permanent `verified` flag: smaller patch, but cannot represent expiry, proof method or withdrawal consistently.
3. Replace the application/framework or introduce a separate identity microservice now: larger migration and operating burden without solving evidence quality by itself.

This design follows approach 1 and does not collect government IDs or biometrics by default. It does not claim that school-domain seeds prove partnerships or support.

## 1. Account and eligibility boundaries

- Account login proves control of an Awoof account. OTP completion proves control of a specific normalized email at that time.
- Student eligibility is a separate evidence record with a method, institution, outcome, proof time, validity deadline and revocation state.
- Approved student-email OTP is accepted first-line assurance, labelled `student_email`; stronger provider proof is labelled `enrollment`. Manual decisions, if added under the separate assisted-review workstream, are labelled `manual_review`.
- A permanent `users.verification_status` flag is compatibility/display data, not an authorization source.
- Do not backfill evidence or email ownership from old verified flags. Existing accounts re-verify through the new flow. No account is selected, merged or logged into using an unproven caller email, phone or registration number.
- Public account signup/login keep issuing sessions. Eligibility endpoints operate on the authenticated student's own identity and never issue login tokens.

## 2. Institution policy and expiry

Separate explicitly approved student-email domains from general website/domain inventory. Add an admin-managed list of exact normalized domains, an approval actor/time, and a policy version for each active institution. No generic `.edu` acceptance, suffix heuristics, automatic copying of website domains or silent activation of seed records.

Approved operational defaults: student-email evidence valid for 90 days; six-digit OTP expires after 10 minutes, allows five failed attempts and a 60-second resend cooldown. Keep validity configurable per approved institution, bounded to 1–365 days. Domain/policy removal or institution suspension invalidates eligibility at read time, without waiting for a scheduled job. Policy version changes durably invalidate prior evidence: removing/re-adding a domain or suspending/reactivating an institution never resurrects it.

Authoritative provider evidence requires an explicit current-enrollment decision, an email exactly matching the account's proven mailbox, a bounded provider validity deadline and known response shape. Effective validity is the earlier of that deadline and a configured institution policy cap (approved default 30 days). Missing/malformed/ambiguous/provider-outage results mean unavailable or unknown, never successful enrollment. Registration-number knowledge alone is not proof of identity. A later explicit authoritative negative decision invalidates earlier positive evidence for that institution and prevents a weaker email retry from overriding it. Unknown/outage does not create either a positive or negative decision. A newer authoritative positive or an authorized reviewed decision is required to clear a negative. Decisions use a monotonically assigned subject/institution generation so out-of-order provider completions cannot overwrite a newer decision.

## 3. Persistence and interfaces

Use additive migrations after 028 (reserved for durable refresh sessions). Core data consists of:

- Approved institution student-mail domains with policy version, configurable validity, approver/time and active state.
- Subject-bound challenges containing purpose, hashed secret, expiry, failures, resend deadline and consumed state. Bind signup claims to the challenge; never accept replacement name/institution claims at confirmation. Resend supersedes the previous challenge, but the subject/purpose send and failed-attempt budgets survive replacement; a new challenge is not a new guessing budget.
- Email-ownership facts tied to the authenticated account and exact email.
- Eligibility evidence tied to student and canonical institution ID, with assurance/method, source identity, verified/denied outcome, observed time, valid-until, invalidation reason and proof/consent references. Persist minimum provider data, not an unbounded provider response.
- Separate versioned verification-processing and merchant-disclosure grants recording the actual affirmative action, notice version, timestamp and withdrawal state. Verification grants bind to the subject and institution; disclosure grants additionally bind to the server-resolved merchant, purpose and exact origin. Never infer consent from visiting a route. A pending signup challenge records the affirmative verification action/version before an account exists and attaches that grant to the proven subject on successful signup; it creates no merchant-disclosure grant. Withdrawing merchant A's grant does not withdraw merchant B's grant or the separate processing grant.
- Append-only administrative decision events for policy edits, eligibility invalidation and future manual decisions.

One transaction-capable eligibility service answers all benefit-authorizing questions, including checkout, assertion issuance, non-consuming validation, transaction reporting and merchant exchange. It selects the deterministic current decision, not any historical positive row, and requires an active student/user/institution; unexpired and unrevoked evidence; matching current institution/domain policy version; and the necessary active consent. Material changes to institution or evidence-bound identity invalidate proof transactionally. Profile display fields cannot rewrite the evidence itself. Consumers and revocation paths use a documented common subject/policy/grant lock order or version predicate so concurrent withdrawal cannot authorize an uncommitted benefit.

Challenge completion rechecks the bound account/email, identity generation, institution policy version and live verification grant, then consumes the challenge and creates evidence in one database transaction. Signup also creates the account and mailbox fact within that transaction. Provider calls happen outside transactions, but their result must be applied only after revalidating the same subject snapshot and generation. Rollback does not burn successful proof or leave an orphan eligibility decision.

Canonical identity uses institution UUIDs rather than institution display text. Self-declared registration numbers never reserve a verified identity or cause account merging. Store any verified registration identifier under the institution's explicit normalization policy and uniqueness scope only after sufficient matched proof. Do not invent a country-wide normalization rule. Before adding unique subject/profile constraints, detect legacy duplicates and fail the migration with an actionable report; never delete/merge legacy people automatically. Concurrent signup/profile creation must enforce one student profile per user, and the same registration string at different institutions is independent.

Existing account signup request/confirm payloads remain compatible, with explicit consent/version fields added where they grant student assurance. The public domain preflight becomes informational only. Approved-domain OTP signup records mailbox proof and time-limited email assurance atomically with account creation.

Authenticated verification interfaces:

- Start: institution plus an affirmative current-version verification-processing grant. Separately record a merchant-disclosure grant only after a fresh explicit action and validation of the merchant's active widget configuration, purpose and exact origin.
- Email request/confirm: send to the signed-in account's email only; consume an account-, institution-, purpose- and consent-bound challenge; issue evidence, not a session.
- Registration verification: attach a strict, email-matched provider decision only to the signed-in account.
- Status: return only the signed-in student's effective status/method/expiry.
- Withdrawal: an account can withdraw its own grant; subsequent assertion issue/consumption must reject it.
- Widget token: require current evidence plus a valid merchant-specific disclosure grant; bind the opaque assertion to those records.

Legacy public registration/WhatsApp completion and magic-link login-grant routes must no longer create/select accounts, write affirmative consent or return JWTs. Retired routes return an explicit upgrade/unavailable response; supported methods are restored only through the authenticated contracts. Advertise only implemented and configured methods.

## 4. Widget and student UX

Keep the Awoof-origin iframe and strict postMessage origin/source checks. Merchant origin allowlists use canonical scheme, host and port, not hostname alone. Migrate legacy host-only entries through explicit operator approval; do not widen their trust automatically. First show sign-in/signup when no authenticated student is present; safely preserve the same-origin widget return path and validated widget context through both forms, then revalidate context on return. Display the signed-in email so the student knows which identity is being verified. Provide a safe top-level authentication/return option when iframe browser storage restrictions prevent login; never weaken origin or authentication checks to work around those restrictions.

Show the merchant and the versioned purpose before sharing. For the selected institution, email OTP is the first method when the domain is approved. Existing current evidence may be reused after the appropriate merchant grant; expired/missing evidence requires re-verification. Unknown schools, unconfigured senders and unsupported methods receive honest unavailable/support guidance, never fake success.

Use server-provided method and proof timestamps. The browser callback contains only an opaque assertion and flow correlation; it cannot itself authorize a discount. Remove global internal student IDs from every merchant-visible callback and response, including legacy widget paths. The merchant-scoped subject is returned only by authenticated server exchange. New accounts without a usable school email and private manual-evidence onboarding require the separate assisted-review design below, not an insecure registration-number shortcut.

## 5. Separate but dependent merchant workstream

Expose a merchant-authenticated assertion exchange/redemption independent of Awoof products, stock, commissions and payment gateways. Enforce merchant/campaign binding, evidence/grant freshness, atomic single use and idempotent retries. Return a merchant-scoped pseudonymous student identifier and minimum eligibility attributes. A committed operation can return its recorded receipt on an idempotent retry without creating another authorization, even if proof was subsequently withdrawn; an uncommitted/new operation must recheck current eligibility. Reusing an idempotency key with a different payload is a conflict. The merchant's server applies its discount under its own rules; provide a reference connector and synthetic fixtures.

The existing transaction report must not consume tokens before validating the operation or outside its database transaction. Any repair here is limited to verification/redemption integrity; Paystack feature work remains deferred.

## 6. Privacy and assisted-review boundary

Public media and private merchant/student evidence require separate access paths. New evidence must never enter unauthenticated static storage. Protect legacy document URLs before adding student evidence uploads.

Proposed assisted-review MVP, for separate task planning: authenticated applicant submits private enrollment evidence; an authorized reviewer accepts/rejects with a reason and bounded validity; applicant can see status and appeal; decision/evidence access is auditable. Do not add automated document approval, biometrics or public evidence links. Personal-email account onboarding, accepted document types, retention schedule and reviewer operating policy need owner approval before this workstream can be called complete.

No code change can establish university data-access contracts, legal compliance or country-wide coverage. Those remain explicit launch prerequisites. Privacy notices and retention controls must state actual behavior and must not assert compliance merely because a checkbox exists.

## 7. Acceptance and rollout

- Negative account-binding tests: wrong subject, mismatched email/provider, changed signup claims and public legacy routes cannot issue another account's session or eligibility.
- Evidence tests: approved-domain email proof works, ordinary website/general domains do not grant it; old flags, expiry, changed policy, identity edits and revoked grants deny benefits. Cover positive-to-negative-to-email-retry, domain removal/re-addition, institution suspension/reactivation, and provider completion after identity/policy changes or a newer decision.
- Challenge tests: concurrent consume has one winner; resend/confirm races are ordered; failures exhaust a budget surviving resend; cooldown and expiry work; failed transaction rolls back consumption; missing sender/store returns unavailable without fake delivery.
- Consent tests: absent/false action, stale notice, account switching and forged grant IDs are rejected. Signup creates only its own affirmative processing grant; independent merchant withdrawal is isolated.
- Merchant tests: wrong merchant/campaign, forged browser success, replay, expired/revoked proof and withdrawn consent cannot grant benefits; legitimate idempotent retry returns the same result, conflicting payloads fail. Use a synthetic PostgreSQL instance to test withdrawal-versus-redemption ordering and rollback. Cross-merchant responses do not reveal a shared internal identifier.
- Identity tests: concurrent signup/profile creation, duplicate legacy diagnostics, and same registration string across institutions preserve canonical ownership without merging or unproven reservations.
- UI checks: signed-out iframe return, signup/login, successful OTP, expiry, unsupported domain, privacy denial and keyboard/mobile operation; include same host/different port, altered merchant context and restricted iframe storage.
- Additive migrations and synthetic local test fixtures first. No automatic student-domain approval or live data mutation. No VPS deployment, merge or push as part of this implementation run.

Remaining owner confirmations: assisted-review scope, accepted enrollment documents and retention policy. The owner has approved this core design and its expiry/abuse defaults; the Astra corrections above tighten engineering semantics without changing that policy. Bounded fixes for existing security and release defects can continue while the separate assisted-review choices are reviewed.
