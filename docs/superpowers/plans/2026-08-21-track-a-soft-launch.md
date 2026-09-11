# Track A Soft Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship marketplace product checkout with hybrid Paystack commission, admin vendor approval gates, and email-verified purchase flow so a soft launch can go live on Hostinger VPS.

**Architecture:** Thin vertical slice on branch `track-a-soft-launch` after reconciling `main` with `origin/main`. Backend adds checkout initialize + Paystack webhook completion; frontend redirects to Paystack and shows callback status; admin approves vendors before they can sell. No new test framework — manual smoke is the gate.

**Tech Stack:** Express 5 + TypeScript + raw `pg`, Next.js 15 App Router, Paystack REST API, Brevo email (existing), Docker Hostinger compose.

**Spec:** `docs/superpowers/specs/2026-08-21-track-a-soft-launch-design.md`

## Global Constraints

- Marketplace checkout only for `deal_type=product` and vendor `payment_method=awoof` (or null → treat as `awoof`).
- Vouchers and `vendor_website` deals stay **Visit Website** — no checkout changes.
- Day-one verification: **email magic-link only**; checkout requires student verified.
- Commission on marketplace uses **`platform_fee_percent`** from `platform_settings` (default 10), **not** per-vendor `commission_rate`.
- Hybrid settlement: split when `vendors.paystack_subaccount_code` set; else collect-all with `settlement_mode='manual'`.
- Do **not** implement Track B items (portal SSO, WhatsApp/reg#, enterprise Verify API, newsletter, Delete My Data, vendor-site webhook).
- Git commits: use `/usr/bin/git commit`; no Co-authored-by trailers; confirm message with user before commit unless executing autonomously per user request.

---

## File map

| File | Responsibility |
|------|----------------|
| `apps/backend/src/database/migrations/020_marketplace_checkout_fields.sql` | `settlement_mode` column; unique `paystack_reference` |
| `apps/backend/src/config/env.ts` | `PAYSTACK_WEBHOOK_SECRET` |
| `apps/backend/src/services/payment/paystack.service.ts` | Extend: initialize, verifyWebhookSignature |
| `apps/backend/src/services/payment/checkout.service.ts` | Commission math, validation, complete transaction |
| `apps/backend/src/controllers/checkout.controller.ts` | POST checkout, GET status |
| `apps/backend/src/controllers/webhook.controller.ts` | Paystack `charge.success` handler |
| `apps/backend/src/routes/checkout.routes.ts` | Student checkout routes |
| `apps/backend/src/routes/webhook.routes.ts` | Webhook route (raw body) |
| `apps/backend/src/index.ts` | Mount webhook **before** `express.json()` |
| `apps/backend/src/controllers/admin-vendor.controller.ts` | `updateVendorStatus` |
| `apps/backend/src/routes/admin.routes.ts` | PATCH vendor status |
| `apps/backend/src/controllers/product.controller.ts` | Gate create/update on vendor `active` |
| `apps/backend/src/routes/products.routes.ts` | Filter public list to `v.status = 'active'` |
| `apps/web/src/app/marketplace/[id]/page.tsx` | Wire purchase button |
| `apps/web/src/app/marketplace/purchase/callback/page.tsx` | Post-Paystack status page |
| `apps/web/src/app/admin/vendors/page.tsx` | Status filter + Approve/Suspend/Reject |
| `env.deployment.example` | `PAYSTACK_WEBHOOK_SECRET` |

---

### Task 0: Git sync and feature branch

**Files:**
- Modify: none (git only)

**Interfaces:**
- Produces: branch `track-a-soft-launch` based on reconciled `main`

- [ ] **Step 1: Fetch and inspect divergence**

```bash
cd "/Users/user/Documents/2026 Projects/awoof"
git fetch origin
git log --oneline HEAD..origin/main
git log --oneline origin/main..HEAD
```

Expected: 1 commit behind (`0cb017a` security PR #16), 4 ahead (including design spec).

- [ ] **Step 2: Merge origin/main into local main**

```bash
git checkout main
git merge origin/main -m "merge: sync security fixes from origin/main"
```

If conflicts: resolve, run `cd apps/backend && npm run build` and `cd apps/web && npm run build`.

- [ ] **Step 3: Create feature branch**

```bash
git checkout -b track-a-soft-launch
```

- [ ] **Step 4: Commit** (only if merge created a merge commit without other pending changes)

Skip empty commit. Continue on `track-a-soft-launch`.

---

### Task 1: Database migration

**Files:**
- Create: `apps/backend/src/database/migrations/020_marketplace_checkout_fields.sql`

**Interfaces:**
- Produces: columns `transactions.settlement_mode`; unique constraint on `paystack_reference`

- [ ] **Step 1: Add migration SQL**

```sql
-- Migration: Marketplace checkout settlement tracking
BEGIN;

ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS settlement_mode VARCHAR(20)
        CHECK (settlement_mode IN ('split', 'manual'));

-- Prevent duplicate webhook processing for the same Paystack reference
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_paystack_reference_unique
    ON transactions (paystack_reference)
    WHERE paystack_reference IS NOT NULL;

COMMIT;
```

- [ ] **Step 2: Run migration locally**

```bash
cd apps/backend
npm run db:migrate
```

Expected: `020_marketplace_checkout_fields.sql executed successfully`

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/database/migrations/020_marketplace_checkout_fields.sql
/usr/bin/git commit -m "feat(db): add settlement_mode and unique paystack reference"
```

---

### Task 2: Environment — Paystack webhook secret

**Files:**
- Modify: `apps/backend/src/config/env.ts`
- Modify: `env.deployment.example`

**Interfaces:**
- Produces: `config.paystack.webhookSecret: string | undefined`

- [ ] **Step 1: Extend env schema and config export**

In `env.ts` schema add:

```typescript
PAYSTACK_WEBHOOK_SECRET: z.string().optional(),
```

In `config.paystack` object add:

```typescript
webhookSecret: env.PAYSTACK_WEBHOOK_SECRET,
```

- [ ] **Step 2: Update deployment example**

Add to `env.deployment.example` under Paystack section:

```
PAYSTACK_WEBHOOK_SECRET=
```

Comment: Paystack Dashboard → Settings → Webhooks; use same secret for HMAC verification.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/config/env.ts env.deployment.example
/usr/bin/git commit -m "chore: add PAYSTACK_WEBHOOK_SECRET to env config"
```

---

### Task 3: Paystack service + checkout helpers

**Files:**
- Create: `apps/backend/src/services/payment/checkout.service.ts`
- Modify: `apps/backend/src/services/payment/paystack.service.ts`

**Interfaces:**
- Produces:
  - `calculateMarketplaceCommission(amount: number, platformFeePercent: number): { commission: number; vendorNet: number }`
  - `getPlatformFeePercent(): Promise<number>`
  - `initializeMarketplacePayment(input): Promise<{ authorizationUrl: string; reference: string }>`
  - `verifyPaystackWebhookSignature(rawBody: Buffer, signature: string): boolean`

- [ ] **Step 1: Add commission helper** — create `checkout.service.ts`:

```typescript
export function calculateMarketplaceCommission(
    amount: number,
    platformFeePercent: number
): { commission: number; vendorNet: number } {
    const commission = Math.round(amount * platformFeePercent) / 100;
    const vendorNet = Math.round((amount - commission) * 100) / 100;
    return { commission, vendorNet };
}

export async function getPlatformFeePercent(): Promise<number> {
    const result = await db.query(
        `SELECT value FROM platform_settings WHERE key = 'platform_fee_percent'`
    );
    if (result.rows.length === 0) return 10;
    return parseFloat(result.rows[0].value) || 10;
}
```

- [ ] **Step 2: Extend `paystack.service.ts`**

Add imports: `crypto`, `axios` (already present).

```typescript
import crypto from 'crypto';

export function verifyPaystackWebhookSignature(
    rawBody: Buffer,
    signatureHeader: string | undefined
): boolean {
    const secret = config.paystack.webhookSecret || config.paystack.secretKey;
    if (!secret || !signatureHeader) return false;
    const hash = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
    return hash === signatureHeader;
}

export async function initializePaystackTransaction(params: {
    email: string;
    amountKobo: number;
    reference: string;
    callbackUrl: string;
    metadata: Record<string, unknown>;
    subaccountCode?: string | null;
    transactionChargeKobo?: number;
}): Promise<{ authorizationUrl: string; accessCode: string }> {
    if (!config.paystack.secretKey) {
        throw new BadRequestError('Paystack secret key not configured');
    }
    const body: Record<string, unknown> = {
        email: params.email,
        amount: params.amountKobo,
        reference: params.reference,
        callback_url: params.callbackUrl,
        metadata: params.metadata,
    };
    if (params.subaccountCode) {
        body.subaccount = params.subaccountCode;
        body.transaction_charge = params.transactionChargeKobo ?? 0;
        body.bearer = 'subaccount';
    }
    const response = await axios.post(
        'https://api.paystack.co/transaction/initialize',
        body,
        { headers: { Authorization: `Bearer ${config.paystack.secretKey}` } }
    );
    const data = response.data?.data;
    if (!data?.authorization_url) {
        throw new BadRequestError('Paystack initialize failed');
    }
    return {
        authorizationUrl: data.authorization_url,
        accessCode: data.access_code,
    };
}

export function generatePaystackReference(): string {
    return `awoof_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}
```

- [ ] **Step 3: Add `completeMarketplaceTransaction` in `checkout.service.ts`**

Idempotent completion used by webhook:

```typescript
export async function completeMarketplaceTransaction(
    paystackReference: string,
    paidAmountNaira: number
): Promise<{ completed: boolean; transactionId?: string }> {
    const txResult = await db.query(
        `SELECT t.*, p.price AS list_price, p.stock
         FROM transactions t
         JOIN products p ON p.id = t.product_id
         WHERE t.paystack_reference = $1`,
        [paystackReference]
    );
    if (txResult.rows.length === 0) {
        return { completed: false };
    }
    const tx = txResult.rows[0];
    if (tx.status === 'completed') {
        return { completed: true, transactionId: tx.id };
    }
    const expectedKobo = Math.round(parseFloat(tx.amount) * 100);
    const paidKobo = Math.round(paidAmountNaira * 100);
    if (expectedKobo !== paidKobo) {
        throw new BadRequestError('Payment amount mismatch');
    }

    await db.query('BEGIN');
    try {
        const stockUpdate = await db.query(
            `UPDATE products SET stock = stock - 1, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND stock > 0 AND deleted_at IS NULL
             RETURNING id`,
            [tx.product_id]
        );
        if (stockUpdate.rows.length === 0) {
            await db.query(
                `UPDATE transactions SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
                [tx.id]
            );
            await db.query('COMMIT');
            return { completed: false };
        }
        await db.query(
            `UPDATE transactions SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [tx.id]
        );
        const savingsDelta = parseFloat(tx.list_price) - parseFloat(tx.amount);
        await db.query(
            `INSERT INTO savings_stats (student_id, total_savings, total_purchases, last_updated)
             VALUES ($1, $2, 1, CURRENT_TIMESTAMP)
             ON CONFLICT (student_id) DO UPDATE SET
               total_savings = savings_stats.total_savings + $2,
               total_purchases = savings_stats.total_purchases + 1,
               last_updated = CURRENT_TIMESTAMP`,
            [tx.student_id, savingsDelta]
        );
        await db.query('COMMIT');
        return { completed: true, transactionId: tx.id };
    } catch (e) {
        await db.query('ROLLBACK');
        throw e;
    }
}
```

- [ ] **Step 4: Typecheck**

```bash
cd apps/backend && npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/services/payment/checkout.service.ts apps/backend/src/services/payment/paystack.service.ts
/usr/bin/git commit -m "feat(payments): Paystack initialize, webhook verify, checkout completion"
```

---

### Task 4: Checkout API

**Files:**
- Create: `apps/backend/src/controllers/checkout.controller.ts`
- Create: `apps/backend/src/routes/checkout.routes.ts`
- Modify: `apps/backend/src/index.ts`

**Interfaces:**
- Consumes: Task 3 helpers
- Produces:
  - `POST /api/checkout` body `{ productId: string }` → `{ authorizationUrl, transactionId, reference }`
  - `GET /api/checkout/:transactionId` → transaction status for owning student

- [ ] **Step 1: Create controller**

Key validation logic in `createCheckout`:

```typescript
const createCheckoutSchema = z.object({ productId: z.string().uuid() });

// After auth student:
const studentRow = await db.query(
    `SELECT s.id, s.verification_status, u.email
     FROM students s JOIN users u ON u.id = s.user_id
     WHERE s.user_id = $1 AND u.deleted_at IS NULL`,
    [req.user.userId]
);
if (!studentRow.rows[0] || studentRow.rows[0].verification_status !== 'verified') {
    throw new BadRequestError('Student must be verified to purchase');
}

const productRow = await db.query(
    `SELECT p.*, v.status AS vendor_status, v.paystack_subaccount_code,
            COALESCE(v.payment_method, 'awoof') AS payment_method
     FROM products p JOIN vendors v ON v.id = p.vendor_id
     WHERE p.id = $1 AND p.deleted_at IS NULL AND v.deleted_at IS NULL`,
    [validated.productId]
);
const product = productRow.rows[0];
if (!product) throw new NotFoundError('Product not found');
if (product.status !== 'active') throw new BadRequestError('Product not available');
if (product.deal_type !== 'product') throw new BadRequestError('This deal must be purchased on the vendor website');
if (product.payment_method !== 'awoof') throw new BadRequestError('This deal must be purchased on the vendor website');
if (product.vendor_status !== 'active') throw new BadRequestError('Vendor is not approved to sell');
if (product.stock <= 0) throw new BadRequestError('Out of stock');

const amount = parseFloat(product.student_price);
const platformFeePercent = await getPlatformFeePercent();
const { commission } = calculateMarketplaceCommission(amount, platformFeePercent);
const settlementMode = product.paystack_subaccount_code ? 'split' : 'manual';
const reference = generatePaystackReference();

const insert = await db.query(
    `INSERT INTO transactions (student_id, product_id, vendor_id, amount, commission,
      status, paystack_reference, payment_source, settlement_mode)
     VALUES ($1,$2,$3,$4,$5,'pending',$6,'awoof',$7)
     RETURNING id`,
    [studentRow.rows[0].id, product.id, product.vendor_id, amount, commission, reference, settlementMode]
);

const { authorizationUrl } = await initializePaystackTransaction({
    email: studentRow.rows[0].email,
    amountKobo: Math.round(amount * 100),
    reference,
    callbackUrl: `${config.frontend.url}/marketplace/purchase/callback?tx=${insert.rows[0].id}`,
    metadata: {
        transactionId: insert.rows[0].id,
        productId: product.id,
        studentId: studentRow.rows[0].id,
        vendorId: product.vendor_id,
    },
    subaccountCode: product.paystack_subaccount_code,
    transactionChargeKobo: settlementMode === 'split' ? Math.round(commission * 100) : undefined,
});
```

Wrap initialize in try/catch: on failure, `UPDATE transactions SET status='failed' WHERE id=...`.

- [ ] **Step 2: Create routes**

```typescript
router.post('/', authenticate, requireRole('student'), asyncHandler(checkoutController.createCheckout));
router.get('/:transactionId', authenticate, requireRole('student'), asyncHandler(checkoutController.getCheckoutStatus));
```

- [ ] **Step 3: Register in `index.ts`**

After products routes block:

```typescript
const checkoutRoutes = await import('./routes/checkout.routes.js');
this.app.use('/api/checkout', checkoutRoutes.default);
```

- [ ] **Step 4: Manual test (dev)**

Start backend; with Postman/curl as verified student JWT:

```bash
curl -X POST http://localhost:5000/api/checkout \
  -H "Authorization: Bearer $STUDENT_JWT" \
  -H "Content-Type: application/json" \
  -d '{"productId":"<uuid>"}'
```

Expected: 200 with `authorizationUrl` or 400 with clear error.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/controllers/checkout.controller.ts apps/backend/src/routes/checkout.routes.ts apps/backend/src/index.ts
/usr/bin/git commit -m "feat(checkout): marketplace Paystack initialize API"
```

---

### Task 5: Paystack webhook

**Files:**
- Create: `apps/backend/src/controllers/webhook.controller.ts`
- Create: `apps/backend/src/routes/webhook.routes.ts`
- Modify: `apps/backend/src/index.ts`

**Interfaces:**
- Produces: `POST /api/webhooks/paystack` (no auth; HMAC verified)

- [ ] **Step 1: Mount raw body route before JSON parser**

In `App` constructor, **before** `initializeMiddlewares()` body parsing, add method `initializeWebhookRoutes()` called first from `start()` or split middleware:

Refactor pattern — in `initializeMiddlewares`, replace single json mount with:

```typescript
// Webhook must receive raw body for signature verification
this.app.use(
  '/api/webhooks/paystack',
  express.raw({ type: 'application/json' }),
  async (req, res, next) => {
    const { default: webhookRoutes } = await import('./routes/webhook.routes.js');
    webhookRoutes(req, res, next);
  }
);
```

Or register webhook router in constructor before `express.json()`.

- [ ] **Step 2: Webhook controller**

```typescript
export async function handlePaystackWebhook(req: Request, res: Response): Promise<void> {
    const signature = req.headers['x-paystack-signature'] as string | undefined;
    const rawBody = req.body as Buffer;
    if (!verifyPaystackWebhookSignature(rawBody, signature)) {
        res.status(401).json({ success: false });
        return;
    }
    const event = JSON.parse(rawBody.toString('utf8'));
    if (event.event !== 'charge.success') {
        res.status(200).json({ success: true });
        return;
    }
    const data = event.data;
    const reference = data.reference as string;
    const amountNaira = (data.amount as number) / 100;
    await completeMarketplaceTransaction(reference, amountNaira);
    res.status(200).json({ success: true });
}
```

- [ ] **Step 3: Test with Paystack test webhook** (or simulate with signed payload using secret)

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/controllers/webhook.controller.ts apps/backend/src/routes/webhook.routes.ts apps/backend/src/index.ts
/usr/bin/git commit -m "feat(webhooks): Paystack charge.success handler for marketplace"
```

---

### Task 6: Admin vendor approval

**Files:**
- Modify: `apps/backend/src/controllers/admin-vendor.controller.ts`
- Modify: `apps/backend/src/routes/admin.routes.ts`
- Modify: `apps/web/src/app/admin/vendors/page.tsx`

**Interfaces:**
- Produces: `PATCH /api/admin/vendors/:id/status` body `{ status: 'active' | 'suspended' | 'rejected' }`

- [ ] **Step 1: Backend controller method**

```typescript
const updateStatusSchema = z.object({
    status: z.enum(['active', 'suspended', 'rejected']),
});

async updateVendorStatus(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    const { status } = updateStatusSchema.parse(req.body);
    const result = await db.query(
        `UPDATE vendors SET status = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND deleted_at IS NULL RETURNING id, status`,
        [status, id]
    );
    if (result.rows.length === 0) throw new NotFoundError('Vendor not found');
    success(res, { message: 'Vendor status updated', data: { id, status: result.rows[0].status } });
}
```

Add `status` query filter to `getVendors` when `req.query.status` present.

- [ ] **Step 2: Route**

```typescript
router.patch('/vendors/:id/status', asyncHandler(adminVendorController.updateVendorStatus.bind(adminVendorController)));
```

- [ ] **Step 3: Admin UI**

In `admin/vendors/page.tsx`:
- Add `<Select>` or buttons for status filter (`all`, `pending`, `active`, `suspended`, `rejected`) passed as query param.
- Add action column with Approve (`active`), Suspend, Reject buttons calling `PATCH /admin/vendors/${v.id}/status`.
- Refresh list after action.

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/controllers/admin-vendor.controller.ts apps/backend/src/routes/admin.routes.ts apps/web/src/app/admin/vendors/page.tsx
/usr/bin/git commit -m "feat(admin): vendor approve, suspend, reject workflow"
```

---

### Task 7: Sell gates + marketplace filter

**Files:**
- Modify: `apps/backend/src/controllers/product.controller.ts` (create + update)
- Modify: `apps/backend/src/routes/products.routes.ts` (public GET list + detail)

**Interfaces:**
- Consumes: `vendors.status === 'active'`

- [ ] **Step 1: Vendor active gate in product controller**

After fetching vendor in `createProduct` and `updateProduct`:

```typescript
const vendorResult = await db.query(
    'SELECT id, status FROM vendors WHERE user_id = $1 AND deleted_at IS NULL',
    [req.user.userId]
);
if (vendorResult.rows[0]?.status !== 'active') {
    throw new BadRequestError('Your vendor account must be approved before managing deals');
}
```

Apply same check in delete if applicable.

- [ ] **Step 2: Public product queries**

In `products.routes.ts`, add to both list and detail WHERE clauses:

```sql
AND v.status = 'active'
```

(already joins vendors as `v`).

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/controllers/product.controller.ts apps/backend/src/routes/products.routes.ts
/usr/bin/git commit -m "feat: gate vendor deals and marketplace on active vendor status"
```

---

### Task 8: Frontend purchase flow

**Files:**
- Modify: `apps/web/src/app/marketplace/[id]/page.tsx`
- Create: `apps/web/src/app/marketplace/purchase/callback/page.tsx`

**Interfaces:**
- Consumes: `POST /api/checkout`, `GET /api/checkout/:transactionId`

- [ ] **Step 1: Replace `handlePurchase` in product detail page**

```typescript
const [isPurchasing, setIsPurchasing] = useState(false);

const handlePurchase = async () => {
    if (!user) {
        router.push('/auth/student/login?redirect=/marketplace/' + productId);
        return;
    }
    if (user.verificationStatus !== 'verified') {
        alert('Please verify your student status to purchase products.');
        return;
    }
    if (product?.deal_type === 'voucher' || product?.vendor_payment_method === 'vendor_website') {
        // existing external link behavior
        return;
    }
    try {
        setIsPurchasing(true);
        const res = await apiClient.post('/checkout', { productId });
        const url = res.data.data?.authorizationUrl;
        if (url) window.location.href = url;
        else alert('Could not start checkout');
    } catch (err: unknown) {
        const msg = (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message;
        alert(msg || 'Checkout failed');
    } finally {
        setIsPurchasing(false);
    }
};
```

Update button to show loading state and hide Purchase for voucher/vendor_website (keep Visit Website).

- [ ] **Step 2: Callback page**

Create `apps/web/src/app/marketplace/purchase/callback/page.tsx`:

```typescript
'use client';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import apiClient from '@/lib/api-client';
import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function PurchaseCallbackPage() {
    const searchParams = useSearchParams();
    const tx = searchParams.get('tx');
    const [status, setStatus] = useState<string>('pending');

    useEffect(() => {
        if (!tx) return;
        const poll = async () => {
            try {
                const res = await apiClient.get(`/checkout/${tx}`);
                setStatus(res.data.data?.transaction?.status ?? 'pending');
            } catch { /* ignore */ }
        };
        poll();
        const id = setInterval(poll, 3000);
        return () => clearInterval(id);
    }, [tx]);

    return (
        <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-lg shadow-sm p-8 max-w-md text-center space-y-4">
                <h1 className="text-xl font-semibold">
                    {status === 'completed' ? 'Payment successful' : status === 'failed' ? 'Payment failed' : 'Processing payment…'}
                </h1>
                {status === 'completed' && (
                    <Link href="/student/profile/receipts"><Button>View receipts</Button></Link>
                )}
                <Link href="/marketplace"><Button variant="outline">Back to marketplace</Button></Link>
            </div>
        </div>
    );
}
```

- [ ] **Step 3: Build web**

```bash
cd apps/web && npm run build
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/marketplace/[id]/page.tsx apps/web/src/app/marketplace/purchase/callback/page.tsx
/usr/bin/git commit -m "feat(web): marketplace checkout redirect and callback page"
```

---

### Task 9: Deploy prep and smoke E2E

**Files:**
- Modify: `DEPLOYMENT.md` (short section on Paystack webhook URL + `PAYSTACK_WEBHOOK_SECRET`)

**Interfaces:**
- Produces: documented go-live checklist

- [ ] **Step 1: Add DEPLOYMENT.md section**

Document:
- Paystack webhook URL: `https://api.<domain>/api/webhooks/paystack`
- Events: `charge.success`
- Rebuild frontend after setting `NEXT_PUBLIC_API_URL`
- Smoke script steps from spec §4

- [ ] **Step 2: Full smoke (Paystack test mode)**

1. Student register → verify email (Brevo configured)
2. Admin login → approve vendor
3. Vendor creates product deal (`deal_type=product`, stock > 0)
4. Student Buy → Paystack test card → callback shows completed
5. Vendor `/vendor/orders` shows order; student receipts show purchase

- [ ] **Step 3: CI check**

```bash
cd apps/backend && npx tsc --noEmit
cd apps/web && npm run build
```

- [ ] **Step 4: Commit**

```bash
git add DEPLOYMENT.md
/usr/bin/git commit -m "docs: Track A Paystack webhook and smoke checklist"
```

- [ ] **Step 5: Open PR** (when user requests)

```bash
git push -u origin track-a-soft-launch
gh pr create --title "Track A: marketplace checkout soft launch" --body "..."
```

---

## Spec coverage checklist

| Spec requirement | Task |
|------------------|------|
| Git sync | Task 0 |
| Marketplace checkout | Tasks 3–4, 8 |
| Hybrid commission | Tasks 3–4 |
| Paystack webhook | Task 5 |
| Admin vendor approval | Task 6 |
| Sell gates | Task 7 |
| Email verify only (no new methods) | Task 4 enforces verified |
| Active vendor on marketplace | Task 7 |
| Deploy checklist | Task 9 |
| Out of scope items | Not in any task |

## Self-review

- No TBD/TODO placeholders in task steps.
- `payment_source` uses existing `'awoof'` value (fits DB CHECK constraint).
- Webhook raw body pattern explicitly documented.
- Types/signatures consistent across tasks 3→5.
