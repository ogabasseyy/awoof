# Remix presentation restoration — 2026-09-21

Owner requested correction after the first implementation materially diverged
from the approved centered Remix composition.

## Changed

- Replaced the gradient/two-column hero with solid blue, centered display
  typography and a lime serif emphasis line.
- Restored the layered cream, lime and pale-blue cards; used the existing Awoof
  logo asset on the pass rather than a text approximation.
- Restored pastel audience cards while preserving their existing destinations.
- Retained a student-verification H1 topic, marketplace and explanation links,
  server-rendered content, and explicit illustrative-state labels.
- No auth, enrollment, consent, merchant API or backend handlers changed.

## Documentation impact

Homepage copy now uses the approved prototype's aspirational description rather
than adding enrollment/provider coverage claims. Card states and categories
are explicitly examples, not live benefits or account results. No new public
routes, contacts, policies or security commitments were introduced; other public
documentation does not require a behavioral update for this presentation change.
Existing release/legal/coverage gates in validation.md remain outstanding.

## Verification

- Regression test first failed at both widths because the old gradient remained.
- Six focused homepage/Remix browser tests passed, including JS-disabled content
  and 390/1440px overflow checks.
- Live in-app browser desktop and 390px inspection performed.
- Changed TSX/test files passed ESLint.
- Fixed invalid Playwright fixture typing in
  student-design-regressions.spec.ts by importing the Page type.
- Browser fixtures read the app origin from AWOOF_APP_ORIGIN (default
  unchanged) so the suite can run alongside a live preview server.
- Full browser suite: 182/182 passed (5.0 minutes); auth unit suite: 56/56 passed.
- Prior lab LCP results describe the previous candidate, not this revision.

The live preview's account-confirmation toast remains a separate local
session/backend issue; this change neither repairs nor validates authentication.
No deployment, merge or new production-activation claim.
