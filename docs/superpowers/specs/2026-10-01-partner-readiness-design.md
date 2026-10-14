# Awoof partner integration readiness

## Intent and success

The owner requested GPT-6.1 Sol agents at medium effort to finish merchant integration and documentation, and reusable connection boundaries for prospective Google, Verve and Paystack partnerships. A merchant unfamiliar with Awoof must be able to configure an integration and complete a disposable test purchase from the guide and runnable example. The existing dirty checkout is preserved; implementation starts from origin/main `0118147` in an isolated workspace.

Keep two products: Awoof Verify and the student deals marketplace. Provider/distribution connectors are channels around those products. Existing enrollment authority, consent, checkout-bound claims, quoted prices, idempotency and retention remain authoritative.

## Deliverables

1. A complete `/developers` quickstart and partner decision guide: exact API/claim URLs, merchant configuration, product mapping, cookies, callback, exchange campaign binding, minor units, retries, payment/reporting, refunds, and test/live boundaries. Extend current pages; synchronize vendor guidance, OpenAPI, inventory and claim evidence in the same change.
2. A dependency-light Node 24 partner SDK plus runnable merchant reference. Use the existing claim-session and exchange APIs; never obtain student JWTs on the merchant server or expose private keys in the browser. A local synthetic simulator is visibly disposable, binds to loopback, and cannot supply production enrollment authority.
3. Explicit reusable capability/adapter contracts for enrollment authority, offer fulfillment, redemption and authenticated payment events. Missing Google/Verve/provider contracts return an unconfigured outcome; a provider name or identity token must never enable a benefit. Document actual configuration and future activation requirements separately.
4. A configured merchant-account Paystack verification mode. Preserve `paystack` as the existing Awoof-account mode; add `paystack_merchant` using a server-only merchant-ID-to-secret mapping. Verify status, amount, NGN currency and metadata binding to vendor/product/benefit authorization. Missing configuration fails closed. Historical exact retries remain historical and do not repeat provider calls. Store the mode distinctly so switching payment mode cannot become an exact retry. Add an additive migration if necessary; do not rewrite historical migrations.
5. Remove unsupported widget-readiness and nonexistent vendor-payment webhook instructions. Integration settings represent configuration, not a successful live checkout. The first complete supported path is hosted redirect plus merchant backend; replacement widget installation stays unavailable until implemented and validated.

## Partner boundaries

Google is treated as a potential offer/entitlement partner; Google sign-in proves account control, not enrollment. Verve is treated as a potential campaign/card-network partner; card-funded cashback needs approved funding, qualification, caps, settlement and reversal contracts. Paystack is a PSP/distribution partner; its payment API is not student eligibility or a native cashback API. Do not create fictional provider endpoints, sponsored offers, public certification claims, new sharing promises, support addresses or provider activation.

## Interfaces and ownership

- Backend worker owns merchant Paystack configuration/verifier/reporting, additive migration and related tests/OpenAPI/schema fixes. Canonical new gateway name: `paystack_merchant`. PSP metadata keys: `awoofVendorId`, `awoofProductId`, `awoofBenefitAuthorizationId`. Exact quote and enrollment enforcement remain in `reportMerchantBenefit`.
- SDK worker owns `packages/partner-sdk/` and `examples/merchant-integration/`, their schemas/tests/readme and synthetic local simulator. Public SDK methods create claim sessions, build hosted claim URL `/marketplace/{productId}?claimSession={claimSessionId}`, exchange with `campaignId = merchantCheckoutId`, and report a transaction. Expose the three metadata keys above for independent merchant Paystack initialization.
- Documentation worker owns existing web developer/partner content, vendor integration guidance and `docs/public-trust-pages.md`. It consumes SDK/backend contracts and links runnable examples and a public merchant-only API reference without exposing internal/admin operations.
- Root owns coordination, design/plan, public contract delivery plumbing as needed, acceptance, whole-change review and PR.

## Verification and completion

Run meaningful backend unit/database tests for wrong merchant, missing config, wrong amount/currency/metadata, duplicate and historical reporting, and unchanged enrollment checks. Run SDK and reference tests against a local synthetic simulator, including nonce/checkout mismatch and replay. Run web typecheck/lint/build and relevant browser checks for documentation navigation/mobile/keyboard. Compare published examples to the generated merchant contract. Record source/test/deployed/provider-enabled states accurately.

No production configuration, provider activation, external contact, legal agreement or live-money action is authorized by this implementation request. A reviewable PR is the delivery; real institutional/provider access remains an external prerequisite, not a fabricated implementation.
