# Student Email-First Authentication Specification

Revision 4, aligned with the upgraded implementation plan. This describes intended behavior, not an assertion of deployed functionality.

## Product outcome

The student login page begins with one email field. After submission, Awoof presents the authentication methods approved for that email domain: password, Microsoft SSO, Google Workspace SSO, or a safe registration/recovery path.

## Boundary: authentication is not student verification

- Authentication answers: “Which Awoof account is signing in?”
- Student verification answers: “Is this person currently eligible for student benefits?”
- The existing Microsoft verification system under `/api/verification/microsoft/*` remains post-login eligibility evidence and is not reused as a login session authority.
- Google Workspace login does not itself mark a student verified. After authentication, the verification page offers implemented, approved enrollment methods: university registration integration or Microsoft Education/Graph. School-email OTP proves mailbox control only. Google enrollment and manual document review are separate deferred projects.
- Withdrawing a verification consent or unlinking a verification identity must never lock the student out of their Awoof account.

## Two-stage assurance shown to the student

A successful institutional OIDC response authenticates the linked account. The resulting assurance depends on the evidence:

- **School account:** `verified` only with approved school-mailbox proof, validated Google hosted-domain membership, or trusted institution membership attestation. A Microsoft tenant ID alone is insufficient because the tenant can include guests. Missing membership evidence leaves school account unverified without blocking an already-linked account from logging in.
- **Student status:** `pending` when no current authoritative enrollment evidence exists. Existing independently valid enrollment stays verified; login must not reset it to pending or replace it with mailbox evidence.

The student status becomes `verified` automatically only when the institution has an enabled, current verification policy and Awoof receives authoritative current-enrollment evidence through Microsoft Education/Graph or an approved university server-to-server adapter. The provider login and verification may be presented as one guided journey, but authentication identity, consent, evidence, expiry, and revocation remain separate records.

An institution may not promote `school account verified` directly to `student verified` merely because it controls an email domain. Accounts may belong to staff, applicants, alumni, or graduates and may remain active after enrollment ends.

## Email-first behavior

1. Collect and normalize the email address.
2. POST it to `/api/auth/student/login-options`; never put it in an Awoof URL or access log. A provider authorization URL may intentionally contain the login_hint email; redact those URLs from telemetry and do not confuse that hint with verified identity evidence.
3. Resolve only the public institution-domain policy. Do not query whether the user account exists.
4. Return a constant-shape response with password and enabled provider methods.
5. Consumer Gmail and unknown domains retain password and recovery/registration paths; they are never treated as school Google Workspace accounts.
6. University of Ibadan domain candidates `stu.ui.edu.ng` and `ui.edu.ng` must be confirmed against the actual runtime database and approved institution policy. Legacy seed entries are not approval. Google is displayed only after an approved, enabled Google login policy and hosted-domain mapping exist.

## SSO account-linking rules

- A provider callback may issue an Awoof session only when `(provider, issuer, subject)` is already linked to one active student user.
- Never auto-link by matching the provider email to an existing Awoof email.
- An unlinked provider identity receives a short-lived handoff. The student must authenticate the existing account with password/recovery, or complete the normal student registration proof, before linking.
- First-time users still provide the existing signup fields, recovery password, required consent and school-mailbox OTP once. Returning linked users can use SSO. Fully passwordless first-time provisioning is not included. An expired linking handoff must not destroy a successfully created account.
- Linking requires recent proof of the target Awoof account and a browser/session-bound provider handoff. Provider email matching is never ownership proof; Microsoft can omit its email claim, so independently prove the account mailbox when required.
- Provider identities are stored separately from Microsoft verification identities.
- Unlinking the final SSO identity is allowed only when the account retains a usable password or another active login identity.
- This release requires password-backed recent reauthentication for link/unlink. Store session authentication provenance; unlink revokes the active session only if it was issued by the removed identity. Login identity revocation and independent enrollment consent are separate lifecycles.

## Provider validation

### Google

- Authorization code flow with PKCE, state, and nonce.
- Validate HTTPS discovery endpoints, issuer `https://accounts.google.com`, client audience, signature, nonce, expiry, and `email_verified=true`.
- Store `sub` as the stable identity. Validate the returned `hd` against the approved policy; never infer Workspace membership from the email suffix alone.
- Request only `openid email profile` for login.

### Microsoft

- Login and enrollment consent are separate authorities. OAuth application separation is a deployment option; a combined authorization requests education scopes only with approved institution policy and explicit enrollment consent. Separate clients may require additional authorization redirects.
- Use a tenant-specific issuer approved by the institution login policy.
- Validate tenant ID, object ID, subject, audience, signature, state, nonce, PKCE, and expiry.
- Request only `openid profile email` for login.

## Security and operations

- Provider client secrets, authorization codes, tokens, OTPs, PKCE verifiers, and full callback payloads are never logged.
- Hash state and browser handoff secrets at rest; encrypt PKCE verifiers if persisted.
- Callback and handoff records expire in ten minutes and are single-use.
- Rate-limit discovery, start, callback failure, and link-confirmation endpoints independently.
- Use generic public errors; attach a random correlation ID to structured, redacted diagnostics.
- Feature flags and per-institution policies can disable new SSO starts while allowing existing password login and owner-safe unlink/recovery.
- Production rollout starts with password-only email-first UI, then a single Microsoft pilot, then a single Google Workspace pilot such as UI after administrator confirmation.

## Benefit-authorization invariant

- No discount, voucher claim, merchant assertion, external-deal redirect, checkout, payment report, or settlement may authorize from `users.verification_status` or `schoolAccountStatus`.
- Every benefit boundary must transactionally read effective student eligibility and require `studentStatus='verified'` with current, unrevoked evidence, consent, identity version, policy version, institution, and expiry.
- The mutable student status is never embedded in JWTs. Benefit boundaries re-read server authority so expiry, denial, and revocation take effect immediately.
- Public deal discovery may show advertised prices and ordinary product information. Redeemable voucher codes and protected discount URLs must be withheld by the server; the merchant validates a merchant-bound assertion before granting a discount. A static shared coupon or public merchant URL cannot enforce student-only redemption.
- Legacy verification tokens are revoked and retired. New product claims require current eligibility and product/merchant-bound authorization; immutable receipts are historical results, not reusable proof of current eligibility. Transaction reporting rechecks authority on first use and permits only exact committed retries.
- External protected claims also bind to a merchant-created browser nonce and checkout session. A shared URL alone cannot grant redemption. The merchant's server must validate the exchange and atomically enforce one redemption per checkout; without that integration protected claims remain disabled. Awoof payment reporting alone cannot secure a merchant's checkout.
- Existing email-only eligibility and Microsoft-to-email eligibility fallback must be removed from benefit authority. Keep mailbox proofs as school-account evidence and historical audit records. A current independent enrollment proof can continue to qualify.
- Manual review is deferred until its own reviewer, evidence, document-storage, expiry, revocation, and retention workflow is implemented. A reserved method name does not enable the method.

## Acceptance criteria

- With an explicitly approved UI policy fixture, `student@stu.ui.edu.ng` resolves to UI without querying account existence. Missing or disabled policies do not advertise Google.
- `student@gmail.com` never receives school-Google treatment.
- Password login and password reset continue to work for all existing accounts.
- A linked provider subject signs in to exactly one active student account.
- An unlinked or changed provider subject cannot take over an email-matched account.
- Provider denial, admin blocking, expired state, callback replay, and storage failure all return the student to a recoverable login state.
- Successful SSO authentication does not change `users.verification_status` or create eligibility evidence.
- Institutional SSO with sufficient membership evidence displays `School account verified`; an unattested tenant/guest login does not. Student status remains pending without authoritative enrollment, or retains its existing independently valid result.
- An enabled/current authoritative institution integration can promote `Student status` to `verified` during the same guided journey, with its own evidence expiry and consent record.
- When an automatic enrollment check is unavailable or inconclusive, the student remains signed in, retains any independently valid enrollment, and can retry an implemented enrollment method. OTP cannot substitute for enrollment. Unintegrated schools show pending with honest guidance, not a nonfunctional document-upload option.
- A generic-verified or school-account-verified user with pending, expired, denied, or revoked student status cannot claim or report a discounted transaction.

## Release and evidence gates

Ship enrollment-only benefit enforcement before enabling school SSO. Retain old evidence and purchases, but never grandfather email-only benefit eligibility. Keep affected benefits closed during mixed-version cutover; rollback cannot restore the old email-eligible build. Provider-only rollback leaves password login and independent enrollment available.

School assertions expire after at most 90 days, capped by institution approval. Enrollment follows its source-specific shorter expiry. Status is derived server-side and never client-editable. When the assurance reader is unavailable, login may succeed with explicitly unavailable assurance; benefits fail closed.

Acceptance requires migration/source/artifact tests, browser coverage, actual runtime database verification, real-provider acceptance and an integrated merchant redemption test. Local mocks cannot establish that a university provides enrollment evidence or that an external merchant enforces discounts.
