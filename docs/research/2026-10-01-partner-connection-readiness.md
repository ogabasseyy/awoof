# Partner connection readiness research

Reviewed: 2026-10-01. Scope: official public competitor and provider documentation. This is an internal implementation brief, not evidence of an Awoof partnership, approved institution, deployed adapter or enabled campaign. No provider was contacted and no live account or production integration was tested.

## Decision

Build a small capability-based partner boundary around Awoof's own merchant verification and redemption contracts. Keep account identity, enrollment evidence, offer eligibility, merchant redemption and payment confirmation separate. A public offer listing or supported payment card must not activate a native benefit or cashback campaign.

The recommendations below are architectural inferences from the cited official sources, not provider promises or negotiated contracts.

## Competitor patterns worth adopting

| Service | Publicly documented surface | Access and useful pattern | Awoof implication |
| --- | --- | --- | --- |
| SheerID | REST verification flow and embeddable JavaScript; program-scoped verification IDs; success, document-upload, pending and error outcomes | Published program and account access required; guide recommends backend-created verification and dynamic OAuth for new integrations. Test mode is program configuration, not a separate host. Verification creation is not idempotent. | Preserve an attempt ID and explicit outcome state; keep test/source/live labels separate; do not recreate an attempt after ambiguous timeout. Awoof must establish its own evidence authority and cannot inherit SheerID's claims. |
| UNiDAYS | Separate verification and marketplace products; public pages describe flexible deployment and consumer-permissioned data | Public pages reviewed do not provide an endpoint/auth/webhook contract. Technical access and commercial terms require partner onboarding. | Keep discovery/listing separate from verified-offer enforcement and explicit sharing consent. Obtain an actual current contract before implementing an adapter. |
| Student Beans / Beans iD (Pion) | Public developer documentation includes SBiD Status API, OAuth SSO and Code Track Pro | Credentials/app registration are issued through an account manager. Status response distinguishes account existence from verified status. Successful code-use reporting is a separate integration. | Use separate eligibility and redemption/reporting interfaces. Prefer merchant-controlled unique codes or checkout-bound redemption rather than treating an identity login as a completed discount. |

Sources: [SheerID REST quickstart](https://developer.sheerid.com/api-quickstart), [UNiDAYS verification](https://corporate.myunidays.com/student-verification), [UNiDAYS marketplace and verification overview](https://corporate.myunidays.com/), [Pion developer onboarding](https://developers.wearepion.com/), [SBiD Status API](https://developers.wearepion.com/sbid-status-api), [Student Beans SSO](https://developers.wearepion.com/beans-id-verification/student-beans-sso/), [Code Track Pro](https://developers.wearepion.com/Code-Tracking-API/).

Pion's public product guidance lists web script, Shopify, hosted landing pages, API/SSO and in-store ID/code options; marketplace placement and opt-in CRM data are distinct services. These are useful channel patterns, not an Awoof coverage or instant-verification claim. [Pion verification](https://www.wearepion.com/products/verification)

For concrete Pion integration planning, SBiD Status uses OAuth `client_credentials` with `id_status`, while code tracking uses its own issued API key and brand/country identifier. The latter reports code, transaction value, qualifying amount, currency and UTC timestamp. Its documentation contains inconsistent example values/labels; verify against the provider before copying samples. Neither API documents an Awoof entitlement import. [SBiD status reference](https://developers.wearepion.com/sbid-status-api), [code tracking reference](https://developers.wearepion.com/Code-Tracking-API/API)

## Provider boundaries

### Google

Google Identity Services documents server validation of signature, audience, issuer and expiry, with `sub` as the stable account identifier. A validated `hd` claim identifies a hosted organization domain; an email suffix alone is insufficient. This establishes account/domain control, not current student enrollment. [Google ID token verification](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)

Google One's public student-offer journey requires SheerID verification and Google-controlled subscription/payment completion. Offer types have different country restrictions and periodic reverification. No public API accepting an Awoof enrollment assertion or allowing Awoof to issue Google student entitlements was found in the reviewed sources. A directory link should send the student to the official offer, retain its conditions and say Google determines eligibility; native Awoof redemption remains unconfigured until a documented bilateral contract exists. Avoid a universal Nigerian availability claim: the reviewed AI Pro/YouTube bundle country list does not list Nigeria. Recheck the exact offer before publishing availability. [Google One student-offer help](https://support.google.com/googleone/answer/17422238?hl=en)

### Verve / Interswitch

Interswitch documents payment checkout and server-side transaction requery before giving value; browser redirect fields are not authoritative. Webhooks cover transaction and other payment events, and a completed transaction event can represent success or final failure. Select and validate the specific payment product contract rather than mixing endpoints from different products. [Web checkout](https://docs.interswitchgroup.com/docs/web-checkout), [webhooks](https://docs.interswitchgroup.com/docs/webhooks)

Official Verve announcements demonstrate branded cardholder reward campaigns and commercial partnerships. They do not provide a public student verification, merchant campaign registration, card-linked offer enrollment or universal cashback API contract. A historical promo is not proof a campaign is currently available. Request current campaign terms, merchant/acquirer eligibility, issuer/card identification, funding ownership, caps, settlement and reversals before activation. [Interswitch campaign/news index](https://interswitchgroup.com/news/)

### Paystack

Paystack's public APIs can confirm payment status server-side; API-call success is distinct from `data.status === 'success'`. Verify the intended transaction reference, amount, currency and environment against the merchant's trusted order record, and make value fulfillment idempotent. Browser callbacks alone cannot authorize value. [Verify payments](https://paystack.com/docs/payments/verify-payments/)

Webhook origin validation uses the raw request payload and `x-paystack-signature` HMAC SHA-512 with the secret key. Delivery retries mean the same payment may arrive repeatedly; acknowledge after durable acceptance and process once. Refund/dispute/transfer events need their own handlers. Test and live environments must remain distinct. [Paystack webhooks](https://paystack.com/docs/payments/webhooks/)

Paystack documents support for Verve payments. This establishes card acceptance, not a funded reward, scheme-level campaign integration or enrollment authority. Do not infer campaign qualification from a user's supplied card brand, a masked card number or an unrelated transaction; obtain approved qualification rules and trustworthy provider evidence. [Paystack card payments](https://support.paystack.com/en/articles/2128258)

## Minimal reusable interface proposal

These are internal responsibilities, not new public endpoint promises. Reuse existing Awoof API routes where their semantics fit.

| Responsibility | Minimum trusted input/output | Mandatory boundary |
| --- | --- | --- |
| Partner capability/configuration | Partner ID, environment, capability set, evidence/contract reference, readiness state | Default `unconfigured`; directory listing does not enable a capability. Live activation requires separate runtime and approval evidence. |
| Identity assertion | Provider subject, issuer/audience, validated account/domain claims | Never produces enrollment eligibility by itself; do not link accounts merely by matching email. |
| Enrollment evidence | Authority, subject binding, institution, evidence date/expiry, eligible/ineligible/pending/unavailable | Require an approved authoritative source and policy; no fabricated Google/Verve/Paystack evidence adapter. |
| Offer eligibility | Merchant/offer IDs, policy version, enrollment decision, approved sharing scope | Explicit student consent; minimum necessary partner claims; permission to share is distinct from marketing opt-in. |
| Redemption authorization | Merchant/order or checkout binding, currency, qualifying amount, eligibility decision, expiry, idempotency key | Merchant backend controls price and discount; atomic single-use consumption or guarded repeat semantics; verification alone does not authorize payment or refund. |
| Payment event normalization | Provider/environment, signed event ID, transaction reference, amount/currency, payment/refund/dispute outcome | Authenticate each provider's event, deduplicate, match trusted order state and handle late/out-of-order events. |
| Cashback campaign (deferred) | Approved campaign, payer/funder, limits, merchant/card qualification, eligible settled transaction and ledger/reversal reference | Separate ledger and reconciliation contract. No universal cashback adapter or live behavior until supplied and reviewed. |

Provider-specific signature/authentication details belong inside each adapter; the shared boundary should receive a validated normalized event, never assume one HMAC scheme works for all providers. Keep secret handles server-only. Persist only the minimum claims and identifiers required by the approved contract and retention policy.

## Documentation and acceptance requirements

1. Publish merchant quickstarts for hosted/API/widget flows with exact current routes, credential placement, consent, eligibility semantics, checkout binding, idempotency, failures and sandbox examples. Provide an explicit integration decision table: external directory offer, code/link redemption, native verification, payment confirmation, deferred cashback.
2. Maintain OpenAPI and examples against implemented schemas. Explain browser/public keys versus server/private keys and source/test/sandbox/deployed/live status. Document webhook raw-body verification and payment reconciliation separately from student verification.
3. Keep a per-partner onboarding record: approved offer/policy, domains/origins, capabilities, evidence authority, contract/schema version, test vectors, expiry, support owner and activation evidence. A partner name in configuration is not commercial approval.
4. Test rejection of expired/mismatched claims, unconfigured capabilities, cross-merchant replay, checkout mismatch, duplicate redemption/payment events and refund/reversal handling where implemented. Verify the merchant actually applies the agreed benefit in its own checkout before calling it operational.
5. Assess `/developers`, partner content, trust/help/privacy pages and `docs/public-trust-pages.md` in the same PR. Public claims must cite internal source/test evidence and separately record deployment/partner activation. Do not add new legal sharing commitments, provider availability, SLAs or new support addresses based on competitor copy.

Outstanding external dependencies: Google entitlement acceptance contract; Verve campaign/qualification/funding/reconciliation contract; any Pion/UNiDAYS commercial/API access agreement; approved merchant offer and checkout enforcement; institution enrollment authority; legal/operational approval for changed data-sharing commitments. Public documentation availability is not authorization to use a provider service or to activate a partnership.
