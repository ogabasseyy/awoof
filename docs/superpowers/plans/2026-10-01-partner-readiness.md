# Partner integration readiness implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development for the owner's explicitly selected GPT-6.1 Sol medium execution. Checkboxes track reviewable deliverables.

**Goal:** Let a new merchant complete a test integration from Awoof's documentation and reusable partner SDK.

**Architecture:** Reuse canonical enrollment/consent/claim/report services. Add merchant-scoped payment verification and portable connection contracts; keep provider-specific activation unconfigured until documented access and approvals exist.

**Tech Stack:** Node 24, TypeScript/Express/PostgreSQL backend, Next.js public guides, dependency-light JavaScript SDK and reference merchant.

**Spec:** `docs/superpowers/specs/2026-10-01-partner-readiness-design.md`

## Global constraints

- Current enrollment alone authorizes benefits; identity and school-account control remain separate.
- Private keys and PSP secrets remain on the merchant/backend server.
- Existing dirty checkout and historical migrations remain intact.
- Public copy distinguishes source, tests, disposable local simulator, deployed behavior and approved provider activation.
- No new legal commitments, provider claims, production activation or live-money action.

## Review focus

- Changed merchant/checkout/product/nonce must fail without authorization or stock movement.
- Wrong account, currency, amount or metadata must fail payment settlement.
- Exact historical retries must remain stable after expiry, consent withdrawal or key rotation.
- Missing provider contract/configuration must return unconfigured, never eligible or paid.
- Documentation must give actual routes/units and correct payment model, with working mobile/keyboard navigation.

## Task 1: Merchant payment boundary and API contract

**Files:** backend configuration, `services/payment/paystack.service.ts`, `services/verification/merchant-benefit.service.ts`, controller/route OpenAPI, migration 085 if needed, relevant tests.

**Interfaces:** `paystack_merchant`; server-only merchant secret mapping; metadata `awoofVendorId`, `awoofProductId`, `awoofBenefitAuthorizationId`; existing `paystack` behavior preserved.

- [x] Add rejection tests for unconfigured/wrong-merchant/amount/currency/metadata and payment-mode replay.
- [x] Implement merchant-scoped verification without automatic fallback to Awoof credentials.
- [x] Keep historical exact reporting retries provider-call-free.
- [x] Ensure generated merchant API contracts contain reporting and current claims/keys/errors.
- [x] Run focused unit, database and artifact checks.

## Task 2: SDK, adapters and disposable reference merchant

**Files:** `packages/partner-sdk/`, `examples/merchant-integration/` only.

**Interfaces:** existing claim-session/exchange/report routes; hosted URL query `claimSession`; campaign equals merchant checkout ID for protected claims; shared payment metadata keys from Task 1.

- [x] Test create/redirect/callback/exchange/report, secret placement and checkout/campaign/nonce errors.
- [x] Build runnable merchant example with durable one-redemption checkout state and provider webhook validation where exercised.
- [x] Provide an explicitly synthetic loopback simulator, eligible/ineligible/expired scenarios and commands.
- [x] Build capability adapters that reject unconfigured providers and preserve identity/enrollment/payment distinctions.
- [x] Run SDK/example acceptance tests; document real-backend setup separately.

## Task 3: Public documentation and onboarding alignment

**Files:** current `/developers`, `content/public/partners.ts`, partner page, vendor integration guidance, public inventory/claim register, documentation tests.

**Interfaces:** Task 1 payment modes/metadata and Task 2 SDK/example paths. A merchant-only API reference is public; admin/auth/internal routes are excluded.

- [x] Add complete hosted checkout quickstart, configuration, currency/units, retry and reconciliation instructions.
- [x] Add partner capability/activation decision guide with no implied Google/Verve/Paystack endorsement.
- [x] Remove nonexistent vendor-payment webhook and unsupported readiness instructions.
- [x] Synchronize internal claim evidence and release/provider gates.
- [x] Run typecheck/lint/build and relevant browser/link/mobile checks.

## Task 4: Whole-change acceptance and review

- [x] Run tests against fresh Node 24 dependencies and disposable databases only.
- [x] Inspect the full diff and public API/examples for code/schema parity and claim accuracy.
- [x] Fix valid findings and rerun affected checks.
- [x] Commit a reviewable change, open and attach a PR, including the repository documentation-impact checklist and outstanding external gates.
