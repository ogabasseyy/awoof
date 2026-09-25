# Controlled merchant eligibility pilot and Ogabassey handoff

**Source status:** implemented in this branch; no deployment, live enrollment-source check, merchant activation, or checkout price change is implied. The hosted page remains unavailable unless both the web and backend processes have `AWOOF_WIDGET_PILOT_ENABLED=true` and the same `AWOOF_WIDGET_PILOT_VENDOR_IDS` list. Backend issuance additionally requires `AWOOF_WIDGET_PILOT_STUDENT_IDS`. Populate that list only with provisioned synthetic test accounts in an isolated sandbox. These flags are an access gate, not evidence of current enrollment. The existing eligibility and disclosure checks still run at issuance and exchange. Keep the flags unset in production.

## Browser contract

1. Register the merchant's exact HTTPS origin in active `widget_configs.allowed_origins` and its hostname in `allowed_domains`. The public widget key is used only for `POST /api/widget/domain-check` with `{domain, origin, apiKey}`. The API validates the exact origin and returns `vendorId`. The private reporting key never enters browser code.
2. From a merchant click handler, call `Awoof.init({apiKey, apiBaseUrl, webAppUrl})` once, then `Awoof.verify({campaignId, purpose})`. The latter opens a first-party Awoof popup. The campaign ID must be 1–100 characters; purpose 1–200. The merchant must display the same purpose and campaign in its own checkout before opening the popup.
3. The hosted page retrieves only the registered merchant display name and origin from `POST /api/widget/merchant-context`. It asks the student to sign in, reads `/api/verification/status`, displays the current eligibility result, and obtains an explicit merchant/purpose disclosure via `POST /api/verification/disclosures`. It then calls the allowlisted `POST /api/merchant-verification/pilot-assertions`. A stale or false eligibility status cannot mint a code: the backend rechecks current evidence and disclosure in the transaction.
4. Awoof sends `{type:'AWOOF_ELIGIBILITY_CODE',state,code,campaignId,expiresAt}` by `postMessage` to the exact registered merchant origin. The widget accepts it only from its popup at the configured Awoof origin with its 128-bit per-attempt state and expected campaign. `verify()` resolves `{code,campaignId,expiresAt}`. No student identity or receipt is sent through `postMessage`. The 43-character opaque code expires in at most two minutes and is not an eligibility result.

This first pilot uses a generic campaign assertion, with no `productId`, checkout nonce, or payment binding. It must remain synthetic-only. The separate protected product-claim session path in the backend is available for a later checkout-specific integration; do not infer that this widget flow grants a discount or authorizes a transaction.

## Merchant server exchange (Ogabassey task)

Create a same-origin checkout endpoint that accepts the code in a JSON body from the merchant browser. Require the merchant's authenticated checkout session, CSRF protection, a server-held expected campaign and purpose, and a unique checkout reference. Never put the code in a URL, analytics event, log, or persistent browser storage. The endpoint should make exactly this server-to-server request:

```http
POST /api/merchant-verification/exchange
Authorization: Bearer <private Awoof merchant reporting key>
Content-Type: application/json

{"code":"<43-character popup code>","campaignId":"<server-held campaign>","idempotencyKey":"<stable unique key for this checkout and code>"}
```

The response is `{success:true,data:{receiptId,merchantSubject,eligible:true,assuranceMethod,institutionId,verifiedAt,validUntil,campaignId}}`. Store the receipt against the same checkout. Check the returned campaign and expiry; treat this pilot result as test-only even if `eligible` is true. The merchant applies and owns any price rule. For future live discounts, require an approved current-enrollment source and `assuranceMethod:'enrollment'` under a reviewed policy before pricing. A successful exchange applies no discount or payment in Awoof.

The first exchange atomically consumes the code. Retry a network-uncertain exchange with the **same** code, campaign and idempotency key to receive the immutable committed receipt. Another key or campaign can conflict. Handle 400/401/403/409/429 as checkout failures without silently granting a discount. Do not retry with a newly generated idempotency key. Keep the reporting key in server secrets. The API does not accept a public widget key or student JWT for exchange.

## Validation and activation gates

- Locally verify popup sign-in return, explicit consent, current status, exchange, cross-origin rejection, expired/replayed code, and a revoked/expired evidence path using synthetic accounts. A browser build or domain-check alone does not prove this flow.
- Before any real merchant use, verify an operational current-enrollment authority, its expiry/revocation behavior, the configured institution policy, legal/data-sharing approvals, merchant acceptance, exact deployment flags, and Ogabassey's checkout/session/price controls. This branch does not activate any of these.
- Public `/partner`, `/developers`, `/trust`, `/help`, privacy and vendor integration copy remains framed around existing server APIs and unavailable widget installation. Keep that public status until a live reviewed rollout. The pilot page itself is noindex, returns an unavailable notice by default, and links to the existing trust/privacy/help routes when enabled.
