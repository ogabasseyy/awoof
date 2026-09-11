# Vendor Payout → Auto Paystack Subaccount Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let vendors pick a bank, verify account name via Paystack resolve, and on save create/update a Paystack subaccount so marketplace checkout can split payments.

**Architecture:** Backend proxies Paystack (list banks, resolve, create/update subaccount). Persist bank fields + `paystack_subaccount_code` on `vendors`. Payout tab UI drives the flow; checkout split logic stays unchanged.

**Tech Stack:** Express/TS backend, Next.js vendor Payment page, Paystack REST API, Postgres migration.

## Global Constraints

- Never expose `PAYSTACK_SECRET_KEY` to the frontend.
- Re-resolve account server-side on save (do not trust client `accountName`).
- Paystack success before DB write.
- Checkout still uses flat `transaction_charge` for commission when splitting.
- Do not commit unless the user asks (repo rule).

---

## File map

| File | Role |
|------|------|
| `apps/backend/src/database/migrations/021_vendor_payout_bank_fields.sql` | Add bank columns on `vendors` |
| `apps/backend/src/services/payment/paystack.service.ts` | `listBanks`, `resolveAccount`, `createSubaccount`, `updateSubaccount` |
| `apps/backend/src/controllers/payment.controller.ts` | Banks, resolve, real payout save |
| `apps/backend/src/routes/vendors.routes.ts` | Wire new GET routes |
| `apps/web/src/app/vendor/payment/page.tsx` | Payout UX + Integration fallback copy |

---

### Task 1: Migration — vendor bank columns

**Files:**
- Create: `apps/backend/src/database/migrations/021_vendor_payout_bank_fields.sql`

- [ ] **Step 1: Add migration**

```sql
-- Persist vendor payout bank details for Paystack subaccount creation
ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS bank_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS bank_code VARCHAR(20),
  ADD COLUMN IF NOT EXISTS account_number VARCHAR(20),
  ADD COLUMN IF NOT EXISTS account_name VARCHAR(255);
```

- [ ] **Step 2: Run migration**

Run: `cd apps/backend && npm run db:migrate`  
Expected: migration applied without error.

---

### Task 2: Paystack service helpers

**Files:**
- Modify: `apps/backend/src/services/payment/paystack.service.ts`

**Produces:**
- `listPaystackBanks(): Promise<{ name: string; code: string }[]>`
- `resolvePaystackAccount(bankCode: string, accountNumber: string): Promise<{ accountNumber: string; accountName: string }>`
- `createPaystackSubaccount(params): Promise<{ subaccountCode: string }>`
- `updatePaystackSubaccount(code, params): Promise<{ subaccountCode: string }>`

- [ ] **Step 1: Implement helpers** using existing axios + `config.paystack.secretKey` pattern; throw `BadRequestError` on Paystack failure; mask account numbers in any logs.

Paystack calls:
- `GET https://api.paystack.co/bank?country=nigeria&currency=NGN`
- `GET https://api.paystack.co/bank/resolve?account_number=&bank_code=`
- `POST https://api.paystack.co/subaccount` body: `business_name`, `bank_code`, `account_number`, `percentage_charge`
- `PUT https://api.paystack.co/subaccount/:code` same updatable fields

---

### Task 3: Payment controller + routes

**Files:**
- Modify: `apps/backend/src/controllers/payment.controller.ts`
- Modify: `apps/backend/src/routes/vendors.routes.ts`

**Consumes:** Task 2 helpers + `getPlatformFeePercent`

- [ ] **Step 1:** Extend `getPaymentSettings` SELECT to include bank columns; return real `payoutSettings`.
- [ ] **Step 2:** Implement `listBanks`, `resolveAccount` controller methods.
- [ ] **Step 3:** Rewrite `updatePayoutSettings`: validate `bankCode`, `bankName`, `accountNumber`; re-resolve; create or update subaccount; then UPDATE vendors.
- [ ] **Step 4:** Register:
  - `GET /payment/banks`
  - `GET /payment/resolve-account`
  - existing `PUT /payment/payout-settings`

---

### Task 4: Vendor Payment payout UI

**Files:**
- Modify: `apps/web/src/app/vendor/payment/page.tsx`

- [ ] **Step 1:** Load banks on payout tab; searchable select by name/code.
- [ ] **Step 2:** Debounce resolve (~500ms, account length ≥ 10); show loading/error/resolved name read-only.
- [ ] **Step 3:** Disable save until resolve OK for current pair; on save call payout-settings; show “Split payments enabled” when code present.
- [ ] **Step 4:** Integration tab: note that Payout tab is preferred; keep manual paste as fallback.

---

### Task 5: Manual verification

- [ ] **Step 1:** `GET /api/vendors/payment/banks` returns banks (with vendor JWT).
- [ ] **Step 2:** Resolve a valid test account (Paystack test env).
- [ ] **Step 3:** Save payout → vendor has `paystack_subaccount_code` + bank fields.
- [ ] **Step 4:** Create checkout for that vendor’s product → `settlement_mode = split`.

---

## Spec coverage

| Spec item | Task |
|-----------|------|
| Persist bank fields | 1, 3 |
| List banks proxy | 2, 3, 4 |
| Resolve + read-only name | 2, 3, 4 |
| Create/update subaccount on save | 2, 3 |
| UI primary path | 4 |
| Checkout unchanged | (no change; verify in 5) |
