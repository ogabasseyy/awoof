# astra-campus-remix — “All Access” (APPROVED)

- **Version:** astra-campus-remix v1 · 2026-09-21
- **Status:** Approved design direction (see `docs/design/design-approval.md`). Static files only; no production code changed.
- **Files:** `index.html`, `style.css` (this directory only)
- **Heritage:** arrived as “Prototype E” after the Task 1A swarm; coordinator-registered, spacing/favicon fixes applied post-review (see approval record).

## Concept

Centered, high-energy hero on Awoof blue (`#244ee7`) with a lime accent (`#d4f565`):
display grotesque + serif-italic accent line, two CTAs, and a tilted “access pass”
card flanked by two category minis. Below: benefit grid, 3-step
connect/verify/access explanation, merchant + university section, trust section,
marquee band, footer with cross-prototype links.

## Why it was approved

- Verification-first hierarchy; hero visual (pass: school account Confirmed /
  enrollment Pending) tells the honesty story visually.
- Separates school-account proof from current-enrollment eligibility in copy and UI.
- No invented counts, logos, testimonials, certifications, or availability claims.
- No-JS readable (zero scripts), skip link, visible focus, reduced-motion support.
- Renders cleanly at 390px and 1440px (verified by coordinator screenshots).

## Proposed tokens (carried into `verification-first-design.md`)

- Blue: `#244ee7` (hero/partner), ink: `#172e68`, paper: `#fcfbf7`
- Accent lime: `#d4f565`; soft tints: `#e6edfd`, `#f3e6db`, `#e6eccb`
- Display: `"Avenir Next", "Trebuchet MS", sans-serif`, tight tracking
  (`-.065em`), clamp(64px, 7.8vw, 112px); accent serif italic: Georgia
- Pills: 40px radius, min-height 48px; focus: 3px `#df671e` outline

## Preview

Serve `docs/design/prototypes` on loopback port 3117 and open
`http://127.0.0.1:3117/astra-campus-remix/`.
