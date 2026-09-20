# Direction B — “The Verification Ledger”

- **Version:** direction-b v1
- **Date:** 2026-09-21
- **Status:** Task 1A prototype concept. Static files only; no production code changed.
- **Files:** `index.html`, `styles.css`, `prototype.js` (this directory only)
- **Independence note:** developed without reading `brand-ia.md` or any `direction-a` files.

## Concept

An editorial, document-like homepage that treats verification as a matter of public
record. Numbered sections, ruled dividers, a ledger panel, and outline “stamp”
chips present assurance levels the way a ledger presents accounts: separate rows
that must never be confused. The tone is a trustworthy explainer, not a sales funnel.

Deliberate contrasts with a typical card-and-gradient marketing alternative:

- **Typography:** system serif display (Georgia stack) for headings, system sans for
  body, monospace for kickers/ledger/stamps — instead of a single geometric sans.
- **Layout:** asymmetric editorial grid with outlined section numerals and a sticky
  double-ruled masthead — instead of a centred hero with floating product art.
- **Imagery:** pure CSS (halftone dot field, ruled lines, stamp chips). Zero image
  bytes, zero font downloads, zero external requests.
- **Colour discipline:** warm paper + ink with Awoof blue reserved for action,
  links, and the ledger keyline — instead of full-bleed brand gradients.

## How the brief is met

- **Verification-first:** the hero pairs the H1 with the assurance ledger, which
  separates account login, school-account proof, and enrollment eligibility before
  any benefit is mentioned. An OTP is described as mailbox control only.
- **Three audiences:** §02 students (browse-first + synthetic benefit cards),
  §03 businesses (four-step narrative, honest “not confirmed” note), §04
  universities (generic cooperation copy, no partners claimed).
- **Readable without JS/animation:** there is no animation at all. Without JS the
  full nav stays visible (the menu button is `hidden` until JS reveals it) and the
  FAQ uses native `<details>`. Single H1, one `<main>`, skip link, labelled navs.
- **Honest unavailable states:** SSO, enrollment feeds, and manual review are
  labelled “Not available in this prototype”; no contact channel is listed because
  none is confirmed; “What this page does not claim” strip bans counts, logos,
  testimonials, certs, and uptime claims.
- **Synthetic content:** every example carries a “Synthetic” tag; the top strip and
  footer repeat “Design prototype — synthetic content”; account/marketplace/
  registration buttons point to `#next-steps`, which explains they demonstrate
  layout only. No forms, API calls, tracking, or downloads.
- **Brand:** Awoof name kept; Awoof blue `#1D4ED8` (from `--primary` in
  `apps/web/src/app/globals.css`) kept for wordmark, actions, and keylines.
  No Pion art, assets, or copy patterns used.

## Design tokens (proposed)

| Token | Value | Use |
| --- | --- | --- |
| `--paper` | `#faf9f5` | Page background |
| `--paper-tint` | `#f1efe7` | Alternating sections |
| `--ink` | `#1c1a15` | Text, footer, prototype strip |
| `--ink-soft` | `#4a463c` | Secondary text |
| `--rule` | `#d8d3c3` | Borders, dividers, dot field |
| `--awoof-blue` | `#1d4ed8` | Links, buttons, kickers, keylines |
| `--awoof-blue-dark` | `#153aa5` | Hover states |
| `--awoof-blue-wash` | `#e8eefc` | Secondary-button hover |
| `--pending-ink` / `--pending-wash` | `#7c4a00` / `#fdf0d5` | Pending/planned states |
| `--radius` | `10px` | Cards, buttons |
| `--max` | `68rem` | Content measure |
| `--font-display` | Georgia stack (system serif) | H1/H2/H3, numerals |
| `--font-body` | System sans stack | Body copy |
| `--font-mono` | System mono stack | Kickers, ledger, stamps |

Contrast checks (normal text, AA ≥ 4.5:1): `#1d4ed8` on `#faf9f5` ≈ 8.0:1;
`#1c1a15` on `#faf9f5` ≈ 15:1; `#4a463c` on `#faf9f5` ≈ 8.5:1;
`#7c4a00` on `#fdf0d5` ≈ 7:1. Touch targets ≥ 44px. Reflow to 320px.

## Preview

Served by the coordinator (default `docs/design/prototypes` on port 3117).
Open `/direction-b/` at 390px and 1440px widths; also check 320px reflow,
keyboard focus visibility, JS-disabled reading, and reduced motion.

## Open questions for coordinator

- Confirm production CTA destinations to wire at implementation time
  (marketplace, student login/signup, business registration routes).
- Confirm the monitored contact channel before any `/contact` copy ships.
