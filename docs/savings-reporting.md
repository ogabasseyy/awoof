# Recorded savings

Student savings (including categories), admin student totals and admin student impact use `transactions.recorded_savings_delta` for completed transactions. Current catalog prices and migration-024 snapshots are not evidence of historical savings.

`totalSavings` (admin impact: `totalStudentSavings`) is null whenever any included completed transaction lacks a recorded delta. `recordedSavings` is the subtotal of known credits and `unknownSavingsCount` counts the excluded unknown credits. An empty history or a completely recorded zero remains zero. Category `savings` follows the same rule; student `totalValue` is null if savings are incomplete. Purchase-history `amount` and `discountAmount` are null when the recorded credit is unknown; `finalAmount` remains the paid amount. Web consumers display unknown or explicitly partial amounts instead of coercing null to zero.

New marketplace settlements persist the exact delta actually credited to `savings_stats` in the same transaction as completion, inventory and outbox writes. This records a new accounting event; it does not certify the provenance of an older pending transaction's snapshot or change the existing settlement calculation. Completed-payment replay leaves the recorded delta and savings balance unchanged. No historical rows are backfilled from prices.

The vendor order API still prohibits refunding Awoof-managed Paystack orders. This change does not introduce a provider refund workflow. Existing external-order refunds reverse the recorded delta and require reconciliation when that historical delta is unknown.

Validation: disposable PostgreSQL integration cases in `apps/backend/src/testing/postgres/savings-reporting.integration.ts`; web label cases run with `node --experimental-strip-types --test apps/web/tests/savings-format.test.mjs` from the repository root.
