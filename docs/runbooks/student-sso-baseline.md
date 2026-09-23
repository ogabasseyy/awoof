# Student SSO Baseline — `codex/student-email-first-auth`

Date: 2026-09-21. Worktree: `/Users/mac/Downloads/awoof-student-email-first-auth`.
Pre-edit baseline: no source files were modified; all results below are the
unmodified-tree record before student-email-first-auth implementation.

## SHAs

- Branch HEAD (`codex/student-email-first-auth`):
  `4a5e7fbcfcc1a57668709f6c670c6ce96659bc42`
- `origin/main`: `4e47ea0cabe1d6a0c3a1c88a74f3138b54e8c6f5`
  ("Harden Microsoft student verification and withdrawal races (#34)")
- Merge-base(HEAD, origin/main):
  `4e47ea0cabe1d6a0c3a1c88a74f3138b54e8c6f5` (main is an ancestor; integration was a no-op)

## Disk gate (step 1)

`df -h /` → `/dev/disk3s3s1 460Gi / 13Gi used / 5.5Gi avail / 70%` — PASS (> 2G free).

## Install (step 2)

Fresh `npm ci` in both apps (no `cp -al` deviation needed):

- `npm ci --prefix .../apps/backend` → `added 343 packages`, `found 0 vulnerabilities`, exit 0
- `npm ci --prefix .../apps/web` → `added 511 packages`, `found 0 vulnerabilities`, exit 0

## Baseline commands (step 3, run from worktree root)

1. `npm --prefix apps/backend test`
   → **PASS, exit 0** — `tests 153, suites 2, pass 153, fail 0`, `duration_ms 3025.04825`
   (tsx unit/in-process suite; test JWT secrets injected via the npm script.)
2. `npm --prefix apps/backend run type-check`
   → **PASS, exit 0** — `tsc --noEmit` clean.
3. `npm --prefix apps/web run test:auth`
   → **PASS, exit 0** — `tests 56, suites 0, pass 56, fail 0`, `duration_ms 194.735291`
   (`node scripts/test-auth.mjs`).
4. `npm --prefix apps/web run test:browser:typecheck`
   → **PASS, exit 0** — `tsc --noEmit --incremental false -p tsconfig.browser-tests.json` clean.

Failures before editing: **none** — 4/4 green (step 4).

## Ports / servers identified

- Owner preview server on `127.0.0.1:3107` is **protected**: never stop,
  restart, or kill it; read-only `curl` only.
- `apps/web/playwright.config.ts:11,23,32` binds its dev webServer and
  `baseURL` to `http://127.0.0.1:3107` — **do not run `test:browser` while the
  owner server holds 3107**. This baseline ran only
  `test:browser:typecheck` (static, no server), so there was no conflict.
- Backend default `PORT 5000`, `DB_PORT 5432`, `REDIS_PORT 6379`
  (`apps/backend/src/config/env.ts:23,28,36`; compose file
  `docker-compose.hostinger.yml:34,36,41`).
- Backend unit/in-process tests bind ephemeral ports only
  (`app.listen(0, '127.0.0.1')`); no fixed test-runner port was used.
- Microsoft Playwright config targets `https://app.awoof.test:3443`
  (`apps/web/playwright.microsoft.config.ts:14`) — real-provider surface,
  not exercised in this baseline.

## Real-provider gates (not exercised)

- Microsoft OIDC is off unless explicitly enabled:
  `MICROSOFT_OIDC_ENABLED` defaults to `'false'`
  (`apps/backend/src/config/env.ts:73`); baseline suite pins this
  ("Microsoft OIDC is off unless explicitly enabled" ✔).
- `test:postgres` spins up an owned scratch Postgres cluster from local
  binaries (`apps/backend/scripts/test-postgres.mjs`) — requires a local
  PostgreSQL binary dir, runs nothing against shared/production data.
- No production credentials were used; no institutions approved; nothing
  pushed, merged, or deployed. Disposable test runner only.
