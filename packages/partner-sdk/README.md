# Awoof partner SDK (source preview)

Dependency-free, server-only Node 24 ESM client with TypeScript declarations. This source preview is included in the merchant starter archive; it is not published to npm and does not prove a deployed integration or provider partnership. Keep the extracted `packages/partner-sdk/` and `examples/merchant-integration/` folders together. No package installation is required.

```js
import { AwoofPartnerClient } from './packages/partner-sdk/index.js';
const awoof = new AwoofPartnerClient({
  apiOrigin: process.env.AWOOF_API_ORIGIN,
  webOrigin: process.env.AWOOF_WEB_ORIGIN,
  privateKey: process.env.AWOOF_PRIVATE_KEY,
});
```

Origins are bare HTTPS origins. HTTP is available only for explicitly allowed loopback simulation. Credentialed API requests never follow redirects and time out after 15 seconds; ambiguous timeouts are not automatically retried. `AwoofApiError` exposes the HTTP status and response body for controlled server-side reconciliation. Never log keys, assertion codes, nonce values or full callback URLs.

The supported hosted flow:

1. Generate a random browser nonce on your server and set a host-only `Secure; HttpOnly; SameSite=Lax; Path=/` cookie. Persist a unique checkout, nonce hash, product, agreed price and stable exchange idempotency key. The reference omits `Secure` only in its explicitly synthetic loopback mode.
2. `createClaimSession({ productId, merchantCheckoutId, browserNonce, origin })` sends the nonce's SHA-256 hex hash to `/api/merchant-verification/claim-sessions`. Persist the returned session and reuse the same checkout/nonce for an exact creation retry.
3. Navigate to `buildHostedClaimUrl(productId, claimSessionId)`: `/marketplace/{productId}?claimSession={claimSessionId}`. Awoof handles real student login, enrollment evidence and disclosure. The merchant never receives a student JWT.
4. Receive the fixed callback `/awoof/student-claim?assertion={code}`. Resolve the checkout using the merchant's own nonce cookie, not untrusted query checkout/product/campaign fields. Call `exchangeClaim({ code, merchantCheckoutId, browserNonce, idempotencyKey })`; the SDK sets `campaignId` equal to `merchantCheckoutId`. Persist the receipt. Product-bound receipts must have a benefit authorization; generic verification does not authorize checkout pricing.
5. Your backend applies its agreed product price and confirms the payment. `reportTransaction({ benefitAuthorizationId, paymentReference, amount, productId, paymentGateway })` reports exactly one discounted transaction. `amount` is integer NGN kobo. Reuse the same fields on retry; this report has no extra client idempotency key.

Do not reuse redeemed checkout IDs. `benefitValidUntil` is the short product authorization deadline; `validUntil` is enrollment evidence expiry and must not substitute for it. Historical receipts may omit the benefit deadline. Do not replace an expired authorization after accepting payment; preserve it for reconciliation. An exact committed retry returns historical settlement, not renewed eligibility.

Payment models:

| Gateway | Meaning |
| --- | --- |
| `paystack` | Existing Awoof-account collection; Awoof verifies that account's reference. An independently collected merchant Paystack payment does not belong to this mode. |
| `paystack_merchant` | Independent merchant collection; Awoof backend needs its separately configured merchant secret mapping and verifies exact amount, NGN and merchant/product/authorization metadata. |
| `other` | Merchant-attested payment reporting; Awoof does not independently verify an arbitrary PSP payment. The merchant must confirm payment before reporting. |

`merchantPaystackMetadata({ vendorId, productId, benefitAuthorizationId })` returns exactly `awoofVendorId`, `awoofProductId` and `awoofBenefitAuthorizationId`. Use these during server-side independent merchant test-payment initialization. `verifyPaystackWebhook(rawBody, signature, merchantSecret)` validates the exact raw bytes with HMAC SHA-512. This helper does not confirm payment status, amount or binding; independently requery the PSP and compare trusted checkout fields before reporting.

`index.d.ts` defines separate enrollment, offer, redemption, authenticated payment-event, Google entitlement and Verve cashback request contracts. `partnerCapabilities()` returns all capabilities as `unconfigured`. `invokeConfiguredAdapter()` refuses execution without configured status and a contract reference. This is a fail-closed wiring boundary, not a contract-review or provider-approval engine. A trusted application must only install reviewed adapters; arbitrary callers must never supply adapters. Google account identity, a listed offer, card support or a provider name cannot configure one. There are no fabricated Google/Verve APIs or active reward flows.

Run checks from the starter/repository root:

```sh
npm --prefix packages/partner-sdk test
npm --prefix examples/merchant-integration test
```

See [the runnable merchant reference](../../examples/merchant-integration/README.md) for a complete disposable walkthrough and real-backend prerequisites.
