# Merchant and partner readiness validation

Reviewed: 2026-10-01. Base: `origin/main` at `01181472b08b16d91aa32180d8ef15fbb2cc46ba`. Implementation branch: `codex/awoof-partner-readiness`. Review: [draft PR #59](https://github.com/ogabasseyy/awoof/pull/59); CI/review, merge and deployment remain pending. This is an internal source and local-validation record, not deployment or partnership evidence.

## Delivered source

- Extended the existing developer, partner and vendor integration pages with the hosted claim/callback/exchange/report sequence, exact units, credential placement, expiration, retries, refund bookkeeping and activation requirements.
- Added a dependency-free Node 24 server SDK, TypeScript capability contracts and a durable local merchant reference with a visibly synthetic simulator and independent merchant Paystack test-checkout support.
- Added independent merchant-account Paystack verification with server-only account configuration and merchant/product/authorization metadata binding. Existing Awoof-account collection remains separate.
- Exposed persisted product authorization expiry as `benefitValidUntil`, distinct from enrollment evidence expiry. The reference checks it before starting a new payment.
- Published a merchant-only OpenAPI download, source starter archive and checksums. CI checks the contract and archive against implementation source; internal routes and local credentials/state are excluded.
- Defined default-unconfigured enrollment, offer, redemption, payment-event, Google entitlement and Verve campaign boundaries. Real entitlement, qualification, cashback funding and reversal implementations still require provider contracts.

## Validation evidence

| Check | Observed result and limits |
| --- | --- |
| Fresh Node 24 dependencies | Backend and web `npm ci` completed in the isolated worktree. |
| Backend unit suite | Final `npm test`: 485 passed, zero failed or skipped. |
| Backend compilation and artifacts | Typecheck, build, compiled OpenAPI parity and artifact runtime/source-absent checks passed. |
| Disposable PostgreSQL targeted suites | Merchant-benefit and checkout-refund run: 41 passed. Final merchant-assertion and merchant-benefit run: 35 passed. Runs overlap; counts are not additive. |
| Full PostgreSQL suite | Both full runs exceeded the launcher's 300-second timeout, including the final run without this task's parallel build/browser load. The full suite is incomplete; no full-suite pass is claimed. Focused changed-path suites passed as listed above, and CI must run the full suite. |
| SDK and merchant reference | Four SDK and fifteen reference tests passed; mocked/local transports only, no provider or real Awoof calls. |
| Download safeguard tests | Five tests passed for merchant API allowlisting, missing definitions, excluded credentials/state, symlink rejection, YAML-split null rejection and deterministic archive headers. |
| Extracted public starter | Both package suites passed after HTTP download from the production build and extraction outside the repository. No installation required. |
| Production web build and HTTP | Web build passed. `/developers` contained the deadline and download links; API, archive and manifest were served successfully, with verified checksums and seven API paths. |
| Web checks | Web and browser typechecks passed. Focused browser runs covered 20 cases, including 360/768/1440 widths, keyboard examples, saved configuration and newly issued key-copy visibility. |
| Lint | No errors. Existing backend warnings and two hook/helper warnings in focused web files remain. |
| Fresh review | Two confirmed findings fixed: conflicting concurrent operations borrowing a success response, and evidence expiry incorrectly standing in for the shorter benefit deadline. Independent conflict reproduction returned 200 then 409. No additional actionable findings in focused final review. |
| Final source parity | Published API/archive match current backend/SDK/reference source; whitespace checks passed. |
| Existing dependency alerts | GitHub's repository alert API reported nine open default-branch alerts on 2026-10-01: one critical, two high, five medium and one low. Runtime reachability and fixes were not established by this integration review; dependency manifests are unchanged. These alerts require separate triage before launch, including [alert 214](https://github.com/ogabasseyy/awoof/security/dependabot/214). |

## Documentation impact

The affected public routes and claim evidence are recorded in `docs/public-trust-pages.md`. Existing trust/help copy already distinguishes account identity, school-account control and current enrollment; no new security claim was required. Privacy, terms and legal schedules have no new purpose, sharing commitment, retention deadline or legal promise in this change. Merchant deployments must still use approved disclosures and executed agreements. No new support address, provider endorsement or production availability is claimed.

## Remaining activation work

1. Review, CI, merge and deployment; apply migrations 085 then 086 (086 validates the NOT VALID constraints from 085) and verify configured runtime routes and artifacts.
2. Approved institution enrollment authority, merchant agreement/annexes, test merchant origins/products/keys and operational ownership.
3. A real end-to-end Awoof checkout and merchant Paystack test payment, including expiry, failed reporting, duplicate events, refunds and reconciliation, before live merchant use.
4. Google entitlement acceptance/fulfillment access and Verve qualification, funding, limits, settlement and reversal contracts before implementing provider adapters or enabling campaigns.
5. Production merchant carts, shared storage, background reconciliation, operational data retention/deletion and refund/dispute ledger. The single-process reference is a starting example and does not implement these production responsibilities.
6. Triage and resolve applicable existing dependency alerts. The focused merchant review is not a full security audit or evidence that every fraud/security concern is addressed.

The original dirty checkout at `/Users/mac/Downloads/Awoof` was left intact. No production configuration, provider account, money movement, outbound partner message or agreement was changed by this work.
