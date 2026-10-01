# Runnable merchant reference

This dependency-free Node 24 example demonstrates the hosted redirect, fixed callback, server-side exchange, trusted product price, independent merchant Paystack test initialization/confirmation, payment reporting and reconciliation. SQLite retains checkout state across restarts. The local synthetic simulator is deliberately separate from real student verification: it performs no login, consent, institutional enrollment checks or real payment. Passing its tests does not prove real-backend deployment, partner approval or a functioning merchant checkout.

The reference is a single-process local integration example, not a production merchant application. It supports one active checkout cookie per browser; starting a second checkout replaces that cookie. Keep the original checkout state for reconciliation. Production systems need their own authenticated carts, multi-tab behavior, background reconciliation, shared durable storage, operational retention/deletion rules, refund/dispute ledger and HTTPS hosting. This example is not a widget and never asks your merchant backend to obtain a student JWT.

## Complete synthetic walkthrough

From the repository root or extracted merchant-starter root (preserve both `packages/` and `examples/`), confirm Node 24:

```sh
node --version
```

No installation or provider credentials are needed. In terminal one:

```sh
AWOOF_SYNTHETIC=1 npm --prefix examples/merchant-integration run simulator
```

In terminal two:

```sh
AWOOF_SYNTHETIC=1 npm --prefix examples/merchant-integration start
```

Open `http://127.0.0.1:4100`. Both listeners bind to loopback. The simulator uses `http://localhost:4200` so its hostname does not receive the merchant's host-only cookie. Keep these hostnames exactly as shown.

1. Select **Start student checkout**. The merchant persists a fresh checkout and nonce hash, sets its `HttpOnly; SameSite=Lax` nonce cookie and creates a claim session using the synthetic private key. The nonce never appears in the hosted claim URL.
2. On the visibly synthetic Awoof page, choose **eligible** and submit. The simulator returns an opaque assertion to the fixed merchant callback. The merchant reads its own cookie, exchanges with `campaignId = merchantCheckoutId` and persists the product authorization.
3. Select **Simulate payment and report**. This creates a synthetic reference and reports `other` with the merchant-attested label. It does not charge a provider, create a wallet credit or pay cashback.
4. Refresh/retry or stop and restart the merchant. **Resume checkout** displays the same durable result while the cookie is valid. The reported transaction is not duplicated. Nonce cookies expire after one hour; do not expect browser resume after expiry.
5. Start fresh checkouts and choose **ineligible** or **expired**. The synthetic claim fails without an authorization or report. These are simulated outcomes, not real enrollment test fixtures.

Claim/API secrets are never embedded in the browser. The local cookie omits `Secure` because this simulator uses loopback HTTP; real-backend mode requires HTTPS and adds `Secure`. SQLite is a built-in experimental Node 24 feature and may emit a warning. Local databases are stored under `examples/merchant-integration/.local/` when invoked via npm, created with restrictive permissions and ignored by Git. Keep them until your synthetic tests are finished; remove the disposable `.local` directory to reset only this simulation. Do not delete real merchant payment evidence to reset a checkout.

Run automated checks from the starter root:

```sh
npm --prefix packages/partner-sdk test
npm --prefix examples/merchant-integration test
```

Tests use temporary/in-memory SQLite databases and local/mock transports. They exercise wrong/missing nonce, cross-checkout replay and subsequent legitimate claim recovery, claim binding, ineligible/expired outcomes, exact retries, concurrent duplicate submissions, restart durability, test-payment initialization and cookie-bound return, live-key/domain rejection, raw-body webhook signatures, provider amount mismatch, payment modes and reconciliation. They never reach Paystack or a live Awoof service.

## Connect to a real Awoof sandbox

Disable `AWOOF_SYNTHETIC`. Obtain an actual sandbox merchant reporting key, vendor/product mapping, current product price and an approved integration origin. Configure that exact HTTPS origin in Awoof's merchant integration settings; deployment/configuration is distinct from a successful test checkout. Serve the reference behind an HTTPS reverse proxy on that origin, forwarding the original Host header to loopback port 4100. Real-backend mode rejects HTTP origins; it cannot create the required Secure cookie from a plain HTTP browser setup.

Set these in your server's secret/environment configuration, never a frontend bundle:

| Variable | Required value |
| --- | --- |
| `MERCHANT_ORIGIN` | Exact approved HTTPS merchant origin, including a nondefault port if applicable. |
| `AWOOF_API_ORIGIN` | Actual sandbox API HTTPS origin, without `/api` or a trailing path. |
| `AWOOF_WEB_ORIGIN` | Actual sandbox Awoof web HTTPS origin. |
| `AWOOF_PRIVATE_KEY` | Issued private `awoof_` server key. |
| `AWOOF_VENDOR_ID` | Your configured vendor UUID. |
| `AWOOF_PRODUCT_ID` | Active Awoof product UUID belonging to that merchant. |
| `STUDENT_PRICE_KOBO` | Agreed single-item student price in integer NGN kobo, exactly matching Awoof's product quote. For example NGN 800 is `80000`. |
| `PAYMENT_GATEWAY` | `paystack_merchant`, `paystack` or explicitly merchant-attested `other`; see below. |
| `MERCHANT_DB_PATH` | Optional durable local SQLite path (default `.local/merchant.sqlite` relative to example working directory). Keep the same path across restarts. |
| `PORT` | Optional loopback server port (default `4100`). |

Then run `npm --prefix examples/merchant-integration start`. The real Awoof hosted page requires real sandbox student login, current institutional enrollment authority and current merchant disclosure. The simulator cannot supply any of these. After returning to the merchant, the receipt must show current enrollment assurance and a product benefit authorization before this example enables payment handling.

The local merchant's trusted amount is configuration, not a price accepted from a browser. Map products/prices on the merchant backend and keep the amount synchronized with the authorization's Awoof quote. A mismatched, withdrawn or expired quote/evidence causes first reporting to fail and require reconciliation; an exact historic retry is not a new eligibility check or benefit.

## Independent merchant Paystack test payment

Set `PAYMENT_GATEWAY=paystack_merchant` and the server-only `MERCHANT_PAYSTACK_TEST_SECRET=sk_test_...`. The reference rejects live keys. The Awoof operator must independently configure that vendor's matching test verification secret in the backend's server-only `PAYSTACK_MERCHANT_SECRET_KEYS` mapping. This example does not configure Awoof or enable a provider.

After the hosted student claim returns, enter your payment email and select **Start merchant Paystack test payment**. The example calls the official [Paystack transaction initialization API](https://paystack.com/docs/api/transaction/#initialize) from its backend using the configured amount, NGN, a random persisted reference and exact authorization metadata. It sends that email only to Paystack, never to Awoof; durable merchant state keeps an email hash to bind an ambiguous initialization retry rather than retaining the cleartext email. No student JWT or identity email is obtained from Awoof. The browser navigates only to the validated `https://checkout.paystack.com` authorization URL.

Complete the provider's **test** checkout. Its return reaches the fixed `/payments/paystack-return` route; the merchant requires the original nonce cookie and exact persisted reference, then verifies the transaction before reporting. A browser return alone cannot prove payment. The reference permits only `sk_test_` credentials and requires verified `domain=test`; initialization responses do not contain a domain field. This path never accepts a live key. A payment initialization retry reuses the original reference/authorization URL rather than creating another payment.

For an integration into your own merchant backend, the same metadata helper is available:

```js
import { merchantPaystackMetadata } from '../../packages/partner-sdk/index.js';
const metadata = merchantPaystackMetadata({
  vendorId: configuredVendorId,
  productId: checkout.productId,
  benefitAuthorizationId: checkout.receipt.benefitAuthorizationId,
});
// Send metadata, trusted amount and NGN when initializing your PSP test payment.
// The runnable reference delegates the payment UI to Paystack's test checkout.
```

Configure the independent merchant's Paystack test webhook to your HTTPS `/webhooks/paystack` path. The reference validates raw-body HMAC, verifies the payment with that merchant test secret, and checks exact reference, successful status, **test** domain, NGN, amount and all three metadata values before durably recording payment/reporting. Browser callbacks are not payment proof. A duplicate `charge.success` returns the same outcome without new reporting. Wrong signature/amount/binding fails without settlement.

Non-`charge.success` signed events persist a minimal deduplicated `provider_review` record and return `202` with an explicit review requirement; refunds/disputes/reversals are not applied by this reference. Inspect those SQLite records and reconcile them in your merchant ledger and approved Awoof process. There is no automatic review worker or refund endpoint in this example. This is a test webhook example, not a complete production refunds or cashback service.

## Awoof-account Paystack and merchant-attested other

`paystack` is reserved for Awoof-account collection: use an Awoof-account payment reference from the approved collection flow. Do not label an independently collected merchant reference as platform `paystack`.

For `paystack` or `other`, configure a random server-only `REFERENCE_REPORT_SECRET` of at least 32 characters. After your existing payment backend confirms payment in the correct collection model, it can POST to the reference's `/payments/report` with `Authorization: Bearer <REFERENCE_REPORT_SECRET>` and JSON `{ "merchantCheckoutId": "<durable-checkout-id>", "paymentReference": "<confirmed-reference>" }`. The reference obtains amount, product, gateway and authorization from durable state; the browser cannot supply them. `paystack` still relies on Awoof's platform-account verification; `other` remains merchant-attested and must not be described as independently PSP-verified. This server endpoint is unavailable in synthetic mode and cannot submit `paystack_merchant`; use its verified webhook instead.

## Failure recovery

Claim sessions have stable checkout bindings. **Resume the same claim session** repeats creation with the same durable checkout and cookie nonce. Exchange retries use the persisted idempotency key, and callback assertions are hashed rather than logged or stored as cleartext. A definitive rejected code/binding does not reserve the checkout; an ambiguous timeout/5xx retains the original code hash and exchange key for its exact retry. Each concurrent operation runs separately in a per-checkout queue so conflicting callbacks/payment references cannot borrow a successful operation's response. A different assertion/checkout/nonce cannot replace an already bound claim. Expired sessions need a new unpaid checkout; redeemed IDs must never be reused.

`receipt.validUntil` describes enrollment evidence expiry. The product authorization's short deadline is the separate `benefitValidUntil`; it is not extended by the evidence TTL. New payment initialization requires a current benefit deadline. For an older backend omitting that field, this sample conservatively caps initialization at two minutes after exchange began locally; it does not infer a guaranteed server deadline. If payment arrives after authorization expiry, keep the order in reconciliation and never obtain a fresh authorization to force settlement.

After confirming payment, the reference stores its payment reference before calling Awoof. If the report times out or fails, the checkout becomes `reconciliation_required` and retains the exact report fields. **Retry the identical report** never recharges, replaces the authorization or changes the amount/payment mode. Inspect merchant and Awoof payment/eligibility state before retrying. A durable `paid_pending_report` record after a crash can use the same `/reconcile` action; background recovery is a merchant deployment responsibility. Exact committed retries return the original report; expired first settlement, consent withdrawal, price changes and provider mismatches may require operational reconciliation instead. Do not grant more stock/value or mint fresh eligibility to make a failed report pass.

## Prospective provider adapters

The SDK exports separate capability contracts and default-unconfigured adapters for enrollment, offers, redemption, authenticated payment events, Google entitlements and Verve cashback. There is no universal cashback, offer-import or Google entitlement implementation. A Google login is account control; accepting a Verve card is payment support. Neither is enrollment authority or authorization to issue a funded reward. Install an adapter only after the actual provider/API access, merchant approval, evidence rules and funding/settlement/reversal contracts exist.
