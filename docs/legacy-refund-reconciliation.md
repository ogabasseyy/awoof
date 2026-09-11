# Legacy external-order savings reconciliation

Migration 038 deliberately leaves historical `recorded_savings_delta` values NULL.
Migration 024's `list_price_snapshot` backfill is not proof of the savings originally
credited. Product prices, current prices and snapshot-minus-amount must not be used
to manufacture that evidence.

A vendor refund with an unknown original credit returns HTTP 409 with reason
`savings_reconciliation_required`. Status, inventory and savings remain unchanged.
Missing or inconsistent purchase-count aggregates also require reconciliation.
This endpoint changes recorded order state; it does not send a payment-provider refund.

An authorized operator must obtain the original credited amount from trustworthy
historical transaction/accounting records and reconcile it against the student's
savings balance and purchase count. Preserve the supporting evidence and operator
approval in the operational audit record. Only after that review may a controlled,
audited data repair set this transaction's exact `recorded_savings_delta` and correct
any inconsistent aggregate. Then retry the ordinary refund endpoint, which reverses
that credit and inventory atomically once. If evidence is unavailable, keep the
case blocked for manual accounting resolution; do not insert a guessed value or zero.

New external transaction reports persist the same delta used to credit savings,
inside the same database transaction. Authentication and route activation are
unchanged. Deploy migration 038 before the updated backend. No historical
reconciliation or production data repair is performed automatically by this patch.
