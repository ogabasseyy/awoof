# Design approval — astra-campus-remix v1

- **Approved direction/version:** astra-campus-remix v1 · 2026-09-21 (“All Access”, Prototype E)
- **Date:** 2026-09-21 (Africa/Lagos evening; session time 2026-09-20 UTC)
- **User approval wording:** “i like the remix too”, then “approved” in reply to
  the coordinator naming astra-campus-remix as the pick and asking for explicit
  approval. Interpreted as approval of astra-campus-remix v1; no other direction approved.
- **Preview URLs:** `http://127.0.0.1:3117/astra-campus-remix/` (served loopback
  port 3117 from `docs/design/prototypes`), comparison index at
  `http://127.0.0.1:3117/`
- **Scope:** homepage visual/content direction only (hero, verification
  explanation, benefit, merchant/university, trust sections; tokens, type,
  buttons, cards, focus, navigation). Material later changes to typography,
  layout, or visual direction require renewed approval. Accessibility fixes
  within the approved direction do not.
- **Not approved:** direction-a v1, direction-b v1, astra-campus v1,
  astra-open-doors v1 (reviewed; retained as reference).

## Requested changes and disposition

1. Mobile lede spacing bug (“possibility.Awoof”) — FIXED in approved files before
   this record (space added before `<br>`).
2. Missing favicon console error — FIXED (`<link rel="icon" href="data:,">`).
3. Skill-grounded research addendum (coordinator-offered, not user-requested) —
   DEFERRED; fold into Task 1B/Task 2 review rather than blocking approval.

## Approved file hashes (sha256, at approval)

- `5d0b148ffa874aa12ccc2866802639e8cf594b9f7bc7bb48d954531d80380c8e`  prototypes/astra-campus-remix/index.html
- `3e21d938dc0557b2ac5bcffa9ab334bcbaaf9010b60fbd23ea16625c3fca381d`  prototypes/astra-campus-remix/style.css
- `dba67a06a38a5f132de3c05931fe4e9cd9288cacad222bbd7c37e5c830790d3c`  prototypes/astra-campus-remix/README.md
- `50c49a47277879302721a99cd57ff4e677236997b6ed3d9111430833d52cec46`  prototypes/index.html

## Other registered versions (reference, not approved)

- direction-a v1: index.html `ec28603f…03fb53`, styles.css `0d4d0250…a9ce951`
- direction-b v1: index.html `e9d15c18…5af808`, styles.css `3d4d3784…7eb2`, prototype.js `9bcddc29…a6032`
- astra-campus v1: index.html `fad1cc76…616588`, style.css `526ecc3e…58566`
- astra-open-doors v1: index.html `08099b3f…f3c4`, style.css `2274a325…0932`
- research: brand-ia.md `b1377e60…6fe55`, journeys.md `c2c520a6…c6d1`, quality.md `1b2ab113…9eb8a`
  (full hashes in coordinator notes; prefixes above are first/last 8 hex)

## Evidence

- Coordinator-rendered screenshots (390px + 1440px) of astra-campus-remix and
  astra-campus via headless Chromium; remix renders cleanly at both widths.
- No production code (`apps/`, configs, auth, backend) changed during Task 1A.
- Worktree: `/Users/mac/Downloads/Awoof-design-upgrade`, branch
  `codex/awoof-design-upgrade` @ `4e47ea0` (+ untracked design artifacts).
