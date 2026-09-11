# Recover a pending payout change

Run this only as an authorized operator with backend database and Paystack configuration.
Pause the API's payout updates and wait for any in-flight requests to finish before recovery.
Find the pending request ID in `payout_change_requests`; do not export bank details to logs.
Wait at least five minutes after the request's last update.

Confirm the vendor's subaccount in the Paystack dashboard. For an ambiguous first-time
creation, locate the created subaccount by its bank/account and business identity.
If no subaccount was created, create one for that vendor in the dashboard first.
Never reuse another vendor's subaccount. Existing local subaccount codes must match.

From `apps/backend`, run:

```sh
npx tsx src/scripts/reconcile-payout.ts REQUEST_UUID ACCT_CONFIRMED_CODE
```

The command reapplies the pending bank settings to the confirmed subaccount, then
atomically updates the local vendor and marks the request applied. It locks both
records, rejects recent or resolved requests, and retains pending state on failure.
It can be retried with the same IDs after a timeout. Resume payout updates after
success. No manual SQL write or clearing of the pending guard is necessary.

Provider contract: https://paystack.com/docs/api/subaccount/#update
