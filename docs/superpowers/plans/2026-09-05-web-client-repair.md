# Web Client Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Repair audit A09 without changing authentication policy or suppressing type checks.

**Architecture:** Preserve the existing separate public and authenticated Axios clients. The iframe's method lookup is public; the notification bell uses the authenticated client.

**Tech Stack:** Existing Next.js 16, React 19, TypeScript 5 and Axios; no dependency changes.

**Spec:** /Users/mac/Downloads/Awoof/docs/audits/2026-09-05-student-verification-audit.md — finding A09. The owner requested fixes after receiving this audit and approved an isolated worktree.

## Global Constraints

- Work only in /Users/mac/Downloads/Awoof/.worktrees/verification-remediation on codex/awoof-verification-remediation.
- Terra implements; Astra reviews. Do not spawn additional agents.
- No push, merge, VPS deployment, production access or real-provider requests.
- Preserve other people's changes. Do not edit shared node_modules or install dependencies.
- No Paystack/marketplace changes and no TypeScript suppression or weakened checks.
- Limit implementation to the listed files; record concerns instead of unrelated fixes.

### Task 1: Restore the intended web HTTP clients

**Files:**
- Modify: apps/web/src/app/widget/verify/page.tsx
- Modify: apps/web/src/components/dashboard/NotificationBell.tsx
- Validation: existing apps/web/tsconfig.json; do not modify compiler configuration.

**Interfaces:** Consumes the existing named export `publicApiClient` and default export `apiClient` from `@/lib/api-client`. Produces no new API.

- [ ] **Step 1: Reproduce the existing failing compiler regression check before implementation.** From the worktree's apps/web directory run `npx --no-install tsc --noEmit --incremental false`. Expected: TS2304 for widget page line 69 and NotificationBell lines 47, 48, 74. This compiler regression is the test-first check for two mechanical client-reference repairs; it must fail for the known references, not missing dependencies. Record output and exit code.
- [ ] **Step 2: Make the minimal repair.** In widget `fetchMethods`, use the already imported public client:

```ts
const res = await publicApiClient.get(`/verification/methods/${universityId}`);
```

In NotificationBell, add its missing authenticated-client import:

```ts
import apiClient from '@/lib/api-client';
```

Do not alter the existing public client, interceptor behavior, notification routes or widget authorization headers.
- [ ] **Step 3: Verify green.** Run `npx --no-install tsc --noEmit --incremental false` and `npm run lint` in apps/web. Expected compiler exit 0; lint exit 0 with pre-existing warnings recorded accurately. Do not call a warning-bearing run warning-free. Avoid a large Next build while disk space is constrained; the final integration gate owns that check.
- [ ] **Step 4: Self-review and commit only the two changed code files and this plan** with `fix(web): restore intended verification and notification clients`. Confirm `git diff --check`. Write RED/GREEN command evidence, changed files, commit and concerns to the assigned report; do not claim the wider audit is fixed.
