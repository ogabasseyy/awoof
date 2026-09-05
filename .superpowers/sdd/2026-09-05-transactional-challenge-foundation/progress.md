# SDD ledger — plan: /Users/mac/Downloads/Awoof/.worktrees/verification-remediation/docs/superpowers/plans/2026-09-05-transactional-challenge-foundation.md

Spec: owner/Astra-approved verification-core design. BASE 325b1bc. Terra implementation, Astra review.

| Interface check | Result |
|---|---|
| Request/consume versus evidence transaction | Both accept PoolClient and never commit; rejection returns a status so attempt increments commit, later proof failures roll back successful consumption. |
| Resend versus guessing budgets | One locked subject/purpose row; fixed-window counters survive challenge replacement and school changes. |
| Local integration versus production safety | New disposable loopback cluster only; explicit environment guards, synthetic data, exact owned cleanup, no supplied application URL. |
| Session test boundary | Existing 325b1bc application code is not owned; report concrete failures for a separate fix rather than silently extending scope. |
| Migration ordering | 028 committed for sessions; 029 belongs to challenge foundation; evidence starts at 030. |
| Route rollout | Primitive is initially unwired. No claim A12 is closed until consumers migrate and are tested. |

Task 1: [x] Terra implementation complete; real-SQL suite, database-free tests, type-check, lint, and diff check passed. Existing lint warnings remain outside this task. The guarded runner rechecks 3 GiB free space before fixture creation.
