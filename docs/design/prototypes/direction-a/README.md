# Direction A prototype — verification-first editorial

Version: **direction-a v1 · 2026-09-21**. Static sample only; no production code changed.

## How to preview

From the worktree root (`/Users/mac/Downloads/Awoof-design-upgrade`):

```bash
python3 -m http.server 3117 --bind 127.0.0.1 --directory docs/design/prototypes
```

Then open `http://127.0.0.1:3117/direction-a/`. Or open `index.html` directly; the stylesheet is a relative link (`styles.css`) and loads locally with no external requests. Fully readable with JavaScript disabled; the menu button is progressive enhancement (nav is visible without JS) and help items use native `<details>`.

## Rationale

- **Editorial, understanding-first layout** per `brand-ia.md` Direction A: light page, left-aligned hero, eyebrow + H1 + lede + two CTAs, with a small static 3-step sample card instead of a phone mockup or cloud art. Distinct structure from the checkpoint/tabs alternative, not a colour variation.
- **Verification before marketplace:** hero topic is verification; benefit cards are compact samples below the explanation, with merchants named as the party that decides each benefit.
- **Three audiences:** Students, Businesses, and Universities each get a card plus a section destination (`#students`, `#businesses`, `#universities` / `#partner`, `#partner-universities`).
- **Separated assurance:** "How verification works" keeps account sign-in, school-account proof, and enrollment eligibility as three numbered items with explicit limits (mailbox proof ≠ current enrollment).
- **Honest states:** pending / expired / unavailable wording included; merchant and university panels state what is unavailable; no counts, logos, testimonials, certifications, policies, store badges, phone numbers, or contact inboxes invented. All samples labelled "Design prototype — synthetic content".
- **Constraints honored:** no real forms, API calls, tracking, or downloads; Log in / Sign up lead to an explanatory note; system fonts only; reduced-motion respected; one H1, semantic H2/H3, skip link, visible focus, 44px targets, 320px reflow.

## Tokens (prototype)

| Token | Value | Use |
| --- | --- | --- |
| `--blue-700` | `#1D4ED8` | Primary actions, links, brand |
| `--blue-800` | `#1E40AF` | Hover |
| `--blue-50` | `#EFF6FF` | Tinted section surface |
| `--ink` | `#0F172A` | Body text |
| `--muted` | `#475569` | Secondary text |
| `--line` | `#E2E8F0` | Rules, card borders |
| `--paper` / `--wash` | `#FFFFFF` / `#F8FAFC` | Surfaces |
| `--banner` / `--banner-ink` | `#FEF9C3` / `#422006` | Prototype banner |
| `--focus` | `#B45309` | Focus ring |
| Type | System stack, 1.0625rem/1.65 body, clamp H1 | Legibility, low bandwidth |
| Spacing/radius | 8pt rhythm, 10px card radius | Cards, sections |
| Max width | 1120px | Reading measure |

Awoof blue and name retained; typography/layout/imagery are original to this sample.

## Files owned (Task 1A)

- `docs/design/prototypes/direction-a/index.html`
- `docs/design/prototypes/direction-a/styles.css`
- `docs/design/prototypes/direction-a/README.md` (this file)

No other paths touched. No git operations run. Did not read `journeys.md` or `direction-b`.
