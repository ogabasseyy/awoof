# Track A Soft Launch — Design Spec

**Date:** 2026-08-21  
**Status:** Approved in design review; awaiting implementation plan  
**Scope:** Soft-launch MVP so real students and a small vendor cohort can complete marketplace purchases with commission recognition.

---

## 1. Goals & success criteria

### In scope

1. Reconcile git (`main` local ↔ `origin/main` including security PR #16).
2. Marketplace **product** checkout on Awoof via Paystack (initialize + webhook).
3. **Hybrid commission:** Paystack transaction split when vendor has `paystack_subaccount_code`; otherwise Awoof collects 100% and flags manual settlement.
4. Admin **vendor approve / suspend / reject** with server-side sell gates.
5. Day-one student verification: **email magic-link only** (Brevo); checkout requires verified status.
6. Production deploy checklist (Hostinger VPS Docker + HTTPS + smoke E2E).

### Out of scope (Track B / later)

- Portal SSO, WhatsApp OTP, registration-number lookup hardening
- Vendor-website Paystack webhook + report-API auth hardening (existing report path stays as-is)
- Voucher “pay on Awoof” (vouchers remain Visit Website)
- Enterprise Verify API, newsletter, Delete My Data, S3/CDN, Sentry wiring, full automated test suite

### Done when

- A verified student can pay for an `awoof` product deal (Paystack test or live).
- Webhook marks the transaction completed; student receipt and vendor order update.
- Unapproved vendors cannot sell; marketplace only lists active vendors’ products.
- VPS deploy runbook works with HTTPS and required secrets.

---

## 2. Decisions locked

| Topic | Choice |
|-------|--------|
| Payment path | Marketplace checkout on Awoof (not vendor-site-first) |
| Verification | Email magic-link only for day one |
| Commission | Hybrid: split if subaccount present, else collect-all + `manual_pending` |
| Implementation style | Thin vertical slice (Approach 1) |

---

## 3. Architecture

### 3.1 Components

| Unit | Responsibility |
|------|----------------|
| `paystack.service` | Initialize transaction (optional split), verify webhook signature, verify payment by reference |
| Checkout / order create API | Auth student → validate product/vendor → insert `pending` transaction → initialize Paystack → return `authorization_url` |
| Paystack webhook route | Idempotent completion: signature → match transaction → `completed` → stock −1 → savings_stats |
| Callback / confirmation page | Student return URL; show pending/success using transaction id or reference |
| Admin vendor status API + UI | Patch status; list filter; Approve / Suspend / Reject actions |
| Product list/create gates | Public list filters active vendors; vendor mutations require `vendors.status = active` |

### 3.2 Purchase + commission flow

```
Student (JWT, role=student, verified)
  → POST /api/checkout  { productId }
  → Validate:
       - student verified
       - product exists, status=active, deal_type=product, stock > 0, not deleted
       - vendor status=active, payment_method=awoof (or null treated as awoof)
       - PAYSTACK_SECRET_KEY configured
  → amount = product.student_price
  → commission = amount * platform_fee_percent / 100
       (platform_fee_percent from platform_settings; default 10)
  → INSERT transactions (
       student_id, product_id, vendor_id, amount, commission,
       status='pending', payment_source='awoof_marketplace',
       settlement_mode = subaccount ? 'split' : 'manual'
     )
  → Paystack POST /transaction/initialize
       amount_kobo = round(amount * 100)
       email = student email
       reference = generated unique ref (stored on paystack_reference)
       callback_url = FRONTEND_URL/marketplace/purchase/callback?tx=<transactionId>
       metadata = { transactionId, productId, studentId, vendorId }
       if vendor.paystack_subaccount_code:
         subaccount + transaction_charge / split so Awoof receives ~commission
  → Return { authorizationUrl, transactionId, reference }
  → Frontend redirects browser to Paystack
  → Paystack → POST /api/webhooks/paystack (charge.success)
  → Verify x-paystack-signature (HMAC SHA512 of raw body with PAYSTACK_WEBHOOK_SECRET or secret key per Paystack docs)
  → Idempotent: if transaction already completed for this reference, 200 OK
  → Validate amount matches; mark completed; decrement stock; upsert savings_stats
       savings delta = product.price - amount (list vs student price)
  → Student lands on callback page → GET transaction status → receipt link
```

### 3.3 Commission / split rules

- **Fee basis:** `platform_fee_percent` on **student_price** (discounted total), matching admin platform settings.
- **Split path:** Vendor has non-empty `paystack_subaccount_code` → initialize with subaccount so vendor receives `amount - commission` and Awoof receives commission (use Paystack subaccount + `transaction_charge` or bearer split as implemented against current Paystack API; document exact payload in implementation plan).
- **Collect-all path:** No subaccount → full amount to Awoof main account; `settlement_mode = 'manual'`; ops settles vendors offline later.
- **Per-vendor `commission_rate`:** Not used for marketplace initialize in Track A (avoid two competing rates). May remain for vendor-website report path. Document this explicitly in admin UI later if confusing.

### 3.4 Vendor approval + gates

**API:** `PATCH /api/admin/vendors/:id/status`  
Body: `{ status: 'active' | 'suspended' | 'rejected' }`  
Auth: admin only. No rejection-reason column in Track A (YAGNI).

**UI:** `/admin/vendors` — status filter + Approve / Suspend / Reject buttons on each row.

**Gates:**

| Surface | Rule |
|---------|------|
| `POST/PUT` vendor product/deal create/update | Vendor must be `active` |
| `POST /api/checkout` | Vendor must be `active` |
| `GET /api/products` (public) | Join vendors where `status = 'active'` and `deleted_at IS NULL` |
| Pending vendor login | Allowed; profile + payment settings allowed; cannot sell |

New registrations remain `pending` until admin approves (existing default).

### 3.5 Email verification

- No new verification methods in Track A.
- Production requires Brevo (`BREVO_API_KEY`, `EMAIL_FROM`, `BREVO_FROM_NAME`).
- Checkout API rejects if student is not verified (mirror existing marketplace UI check).

### 3.6 Data changes

Migration (new numbered SQL after `019_...`):

- `transactions.settlement_mode` `VARCHAR` CHECK IN (`split`, `manual`) NULL allowed for legacy rows; set on new marketplace checkouts.
- Optional: `transactions.payment_source` already exists from migration 007 — use value `awoof_marketplace` for this flow.
- Ensure unique index on `paystack_reference` where not null (idempotency); if only non-unique index exists today, add unique constraint carefully (or enforce uniqueness in app + handle conflict).

No new tables required for Track A.

### 3.7 Frontend changes

- `apps/web/src/app/marketplace/[id]/page.tsx`: replace “coming soon” with checkout call + redirect.
- New page: `/marketplace/purchase/callback` — reads `tx` query, polls/fetches status, links to receipt.
- `apps/web/src/app/admin/vendors/page.tsx`: filter + status actions.
- Voucher / `vendor_website` deals: keep Visit Website behavior (no change).

### 3.8 Backend route map (new / changed)

| Method | Path | Notes |
|--------|------|-------|
| POST | `/api/checkout` | Student auth; create pending + Paystack init |
| GET | `/api/checkout/:transactionId` | Student owns tx; status for callback page |
| POST | `/api/webhooks/paystack` | Raw body for signature; no JWT |
| PATCH | `/api/admin/vendors/:id/status` | Admin |
| GET | `/api/products` | Filter active vendors |
| Vendor product writes | existing routes | Gate on vendor active |

Mount webhook **before** JSON body parser if signature needs raw body, or use `express.json` verify callback — follow existing Express setup.

### 3.9 Error handling

- Missing Paystack config → 503/400 clear message; no pending tx left orphaned if init fails (delete or mark `failed`).
- Webhook bad signature → 401; do not mutate.
- Duplicate webhook → 200, no double stock decrement / savings.
- Wrong deal type / inactive vendor / unverified student → 400 with explicit code/message.
- Stock race: decrement only if `stock > 0` in same UPDATE … RETURNING; if fails, mark failed and log for manual review (no auto-refund in Track A).

### 3.10 Testing (Track A minimum)

- Unit: commission calculation helper; settlement_mode selection.
- Manual smoke (required for done): register → verify email → admin approve vendor → create product → pay (Paystack test) → webhook → receipt + vendor order.
- Optional: one webhook idempotency test with mocked signature if feasible without new framework struggle (repo currently has no test runner — prefer not to introduce a full Jest stack unless trivial; manual smoke is the gate).

---

## 4. Git & deploy

### Git

1. Fetch origin; merge or rebase local ahead commits onto `origin/main` (security fixes).
2. Implement Track A on branch `track-a-soft-launch` from reconciled main (preferred over committing straight to main).
3. Open PR when soft-launch slice is smoke-ready.

### Env (additions)

| Variable | Purpose |
|----------|---------|
| `PAYSTACK_SECRET_KEY` | Initialize + verify |
| `PAYSTACK_PUBLIC_KEY` | Frontend if needed for inline (redirect flow may not need it) |
| `PAYSTACK_WEBHOOK_SECRET` | Prefer dedicated webhook secret if Paystack provides; else document using secret key per Paystack HMAC docs |
| Existing | `BREVO_*`, `JWT_*`, `REDIS_PASSWORD`, `NEXT_PUBLIC_API_URL`, `CORS_ORIGIN`, `FRONTEND_URL` |

### Deploy checklist

1. Set VPS `.env`; rebuild web image **after** `NEXT_PUBLIC_API_URL` is correct.
2. Configure Paystack webhook → `https://api.<domain>/api/webhooks/paystack`.
3. HTTPS reverse proxy for app + API.
4. `docker compose -f docker-compose.hostinger.yml up -d --build` → migrations → create admin.
5. Run smoke E2E above.

---

## 5. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Paystack split payload differs by API version | Spike initialize with test keys early; keep collect-all fallback |
| Webhook never reaches VPS (HTTP only / firewall) | Require HTTPS + documented Paystack dashboard URL |
| Stock oversell | Conditional stock decrement; accept rare failed paid order for manual fix in Track A |
| Dual commission fields confuse ops | Spec: marketplace uses `platform_fee_percent` only |

---

## 6. Non-goals reminder

Do not implement Track B items in the Track A PR. Vendor-website payment docs that reference a missing webhook may stay stale until Track B; optional one-line UI note “Marketplace Paystack webhook is `/api/webhooks/paystack`” is allowed if touching integration page.

---

## 7. Approval history

- Payment path: Marketplace on Awoof  
- Verification: Email only  
- Commission: Hybrid (C)  
- Approach: Thin vertical slice  
- Design §1 purchase flow: approved  
- Design §2 vendor gates: approved  
- Design §3 verify/git/deploy: approved  
