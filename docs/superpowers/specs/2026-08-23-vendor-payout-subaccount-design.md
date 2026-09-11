# Vendor Payout → Auto Paystack Subaccount — Design Spec

**Date:** 2026-08-23  
**Status:** Approved; implemented 2026-08-23  
**Scope:** When a vendor configures payout bank details, Awoof verifies the account and creates (or updates) a Paystack subaccount so marketplace checkout can split payments on the fly.

---

## 1. Goals & success criteria

### In scope

1. Persist vendor payout bank fields (today’s payout save does not reliably store them).
2. Proxy Paystack **List Banks** for a searchable bank dropdown.
3. Proxy Paystack **Resolve Account** after account number entry; show resolved name read-only for confirmation.
4. On save: create or update Paystack **subaccount**, store `paystack_subaccount_code` on the vendor.
5. Vendor Payment UI: primary path is bank select → resolve → save (manual subaccount paste becomes secondary/fallback).
6. Existing checkout split logic unchanged: `paystack_subaccount_code` present → `settlement_mode: split` + flat `transaction_charge` = commission.

### Out of scope

- Changing commission math or platform fee % admin UI
- Instant settlement schedule customization beyond Paystack defaults
- Multi-currency / non-NGN banks
- Requiring subaccount before vendor can list products
- Migrating historical `manual` transactions to split

### Done when

- Vendor can pick a bank, enter account number, see resolved account name, save.
- Save persists bank fields and a Paystack `ACCT_…` code on `vendors`.
- Next completed marketplace product checkout for that vendor uses `settlement_mode: split` (assuming Paystack accepts the subaccount).
- Invalid bank/account fails with a clear API/UI error before creating a subaccount.

---

## 2. Decisions locked

| Topic | Choice |
|-------|--------|
| UX | **B:** Resolve account name for confirm, then create subaccount on save |
| Bank picker | Paystack List Banks → searchable dropdown (code + name) |
| Account name | Read-only from Resolve Account (vendor does not type it) |
| Paystack access | Backend proxies with secret key (never expose secret to web) |
| Storage | Columns on `vendors` (not a separate payout table for MVP) |
| Subaccount fee field | Set `percentage_charge` to current `platform_fee_percent` as Paystack-required default; **checkout continues to pass flat `transaction_charge` (commission in kobo)** so Awoof’s take stays exact |
| Existing subaccount | If vendor already has `paystack_subaccount_code`, **update** that subaccount on bank change; else **create** |
| Manual paste | Keep as advanced/fallback on Integration tab; payout tab is the primary path |

---

## 3. Architecture

### 3.1 Flow

```
Vendor (Payment → Payout)
  → GET /api/vendors/payment/banks
  → Select bank (bank_code + bank_name)
  → Type NUBAN account_number (debounce ~500ms when length ≥ 10)
  → GET /api/vendors/payment/resolve-account?bankCode=&accountNumber=
  → UI shows resolved account_name (read-only)
  → PUT /api/vendors/payment/payout-settings
       { bankCode, bankName, accountNumber, accountName }
  → Backend:
       1. Validate body matches last resolve (or re-resolve server-side)
       2. Create or update Paystack subaccount
       3. UPDATE vendors SET bank_*, paystack_subaccount_code, …
  → Response includes payoutSettings + paystackSubaccountCode
  → Later checkout: initialize with subaccount → split
```

### 3.2 Components

| Unit | Responsibility |
|------|----------------|
| `paystack.service` | `listBanks()`, `resolveAccount()`, `createSubaccount()`, `updateSubaccount()` |
| Payment controller | Banks / resolve / payout-settings endpoints; vendor auth |
| Migration `021_…` | `bank_name`, `bank_code`, `account_number`, `account_name` on `vendors` |
| Vendor Payment → Payout tab | Searchable bank select, resolve UI, save CTA, split-enabled status |
| Checkout (unchanged) | Uses `paystack_subaccount_code` when present |

### 3.3 Paystack API usage

| Action | Endpoint | Notes |
|--------|----------|--------|
| List banks | `GET /bank?country=nigeria&currency=NGN` | Cache in Redis ~24h optional; OK to call live for MVP |
| Resolve | `GET /bank/resolve?account_number=&bank_code=` | Fail closed on mismatch |
| Create | `POST /subaccount` | `business_name`, `bank_code`/`settlement_bank`, `account_number`, `percentage_charge` |
| Update | `PUT /subaccount/:id_or_code` | When code already exists |

`business_name`: vendor `company_name` or `name`.  
`percentage_charge`: `getPlatformFeePercent()` (informational default; per-tx charge still flat).

### 3.4 Validation & security

- Vendor role + auth required on all three endpoints.
- Re-resolve on save (server-side) so client cannot spoof `accountName`.
- Require resolved name to match Paystack resolve result before create/update.
- Do not log full account numbers at info level; mask in logs (`****1234`).
- Rate-limit resolve lightly if easy (optional); at least debounce on client.

### 3.5 Error handling

| Case | Behavior |
|------|----------|
| Resolve fails | 400 with Paystack message; UI clears name, disables save |
| Create/update subaccount fails | 400/502; do **not** clear existing bank fields if update fails mid-way prefer transactional: only write DB after Paystack success |
| Missing `PAYSTACK_SECRET_KEY` | 400 “Paystack not configured” |
| Bank list empty | Show empty state + retry |

DB write order: **Paystack success first**, then `UPDATE vendors`. If DB fails after Paystack create, return error asking support/retry (subaccount may exist; update path on retry should find/use code if we stored nothing — MVP: return error with message to retry save; optional later: look up by account).

---

## 4. API contract (vendor-auth)

### `GET /api/vendors/payment/banks`

Response `data.banks`: `{ name: string, code: string }[]`

### `GET /api/vendors/payment/resolve-account`

Query: `bankCode`, `accountNumber`  
Response `data`: `{ accountNumber, accountName, bankId? }`

### `PUT /api/vendors/payment/payout-settings`

Body: `{ bankCode, bankName, accountNumber }`  
(`accountName` optional from client; server re-resolves and stores canonical name)

Response `data`: `{ payoutSettings, paystackSubaccountCode }`

### `GET /api/vendors/payment/settings` (extend)

Return real `payoutSettings` from vendor columns + existing `paystackSubaccountCode`.

---

## 5. UI changes (Payment → Payout)

- Replace free-text Bank Name / Bank Code / Account Name with:
  - Searchable bank combobox
  - Account number field
  - Resolved account name display (loading / error / success)
- Save disabled until resolve succeeds for current bank+number pair
- After save: badge “Split payments enabled” when `paystackSubaccountCode` present
- Short helper copy: “We’ll create a Paystack subaccount so student purchases can pay you and Awoof automatically.”
- Integration tab: keep manual subaccount field as fallback; copy notes payout tab is preferred

---

## 6. Testing / verification

1. List banks returns Nigerian banks with codes.
2. Resolve known test NUBAN (Paystack test credentials) shows expected name.
3. Save creates subaccount; vendor row has code + bank fields.
4. Marketplace checkout for that vendor’s product → transaction `settlement_mode = split`.
5. Change bank details → subaccount update; new details stored.
6. Bad account number → no DB update of subaccount code.

---

## 7. Implementation notes

- Prefer extending `paystack.service.ts` rather than a new service file unless size warrants it.
- Frontend: debounce resolve; cancel in-flight requests on bank/number change.
- No new npm dependency required if a simple filterable `<select>` / existing combobox pattern exists; otherwise a lightweight searchable select is fine.
