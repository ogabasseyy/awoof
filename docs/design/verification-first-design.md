# Verification-first design contract (from astra-campus-remix v1)

Approved direction: astra-campus-remix v1 (“All Access”). Implementers follow
this contract; material changes to typography, layout, or visual direction need
renewed approval (see `design-approval.md`).

## Tokens

- `--blue: #244ee7` hero/partner surfaces, white text on it
- `--ink: #172e68` / body `#162b79`-family text on paper
- `--paper: #fcfbf7` page background; `--line: #d8dcec` hairlines
- `--accent (lime): #d4f565` primary CTA fill, emphasis, marquee
- Soft section tints: `#e6edfd`, `#f3e6db`, `#e6eccb`; partner tint alt `#e8edf9`
- `--focus: #df671e` 3px visible focus outline, 5px offset
- Notice bar: `#e8e8e0` bg, `#303931` text

## Type scale

- Display: `"Avenir Next", "Trebuchet MS", sans-serif`, weight 600–650,
  tracking `-.065em`, `clamp(64px, 7.8vw, 112px)` desktop hero,
  `clamp(49px, 12.7vw, 78px)` mobile; line-height ~0.96
- Accent line: Georgia serif italic, lime on blue
- H2: `clamp(35px, 4.8vw, 64px)`, tracking `-.045em`, weight 550
- Eyebrow: 11px, uppercase, `.16em` tracking, weight 700
- Lead: 17–18px / 1.65; body 15–16px / 1.6–1.7

## Spacing and layout

- Measure: `max-width 1320px`, 6% gutters; section padding 90px desktop / 60px mobile
- Hero: centered copy (max 960px), CTAs centered, product visual below
- Grids: 3-up desktop → 1-up ≤760px; partner 1.2fr/1fr → stacked
- Cards: 12–25px radius; pills: 40px radius, min-height 48px, 44px+ touch targets

## Components

- Buttons: lime primary (dark text), outline secondary (currentColor); inline-flex,
  gap, semibold 14px
- Ticket/pass card: paper or lime fill, tilted (-5° to -8°), dashed rule
  separators, status rows (label left, state right: Confirmed / Pending)
- Benefit cards: tinted fills, eyebrow index, large glyph, title + one line
- Marquee band: lime bg, 13px tracked uppercase line
- Mobile menu: native `<details>` (no-JS); skip link; `tabindex=-1` main target

## Navigation (proposed)

Students → `/marketplace`, Businesses → `/partner`,
Universities → `/partner#universities`, Trust → `/trust`, Help → `/help`;
retain working login/signup. Prototype anchors (`#students`, `#partners`,
`#universities`, `#how`, `#trust`) map to these routes in implementation.

## Page outline (homepage order)

1. Purpose + CTAs → 2. audience paths → 3. verification explanation
   (connect / verify / access) → 4. illustrative product sample →
5. benefit preview → 6. trust/help → 7. partner next step.

## Copy and claim register (binding)

- Separate: account sign-in ≠ school-account proof ≠ current-enrollment eligibility.
- Pending/unavailable states shown honestly; never a green “verified” badge from
  generic status. No mystery badges anywhere.
- No invented counts (“thousands”), logos, testimonials, app-store badges,
  certifications, legal policies, or monitored contacts.
- Mock/illustrative states labelled; synthetic data only in prototypes.
- Trust section must explain what is checked, what a merchant learns, what
  happens next — expand beyond the prototype's single paragraph at build time.
- Legal copy (privacy/terms) ships only with owner-approved content; missing
  destinations are a release blocker, not silent 404s.
