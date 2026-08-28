# Marketing & Auth UI Revamp — Design Spec

**Date:** 2026-08-22  
**Status:** Approved (Approach 1; scope C; web-first CTAs; light copy rewrite)

## Goals

Bring the public home page and all auth surfaces into the same lively system as marketplace/dashboards: Plus Jakarta Sans, soft blue wash `#F4F7FD`, Awoof blue `#1D4ED8`, intentional Framer Motion, clear typography hierarchy. Highly interactive without clutter.

## Non-goals

- Full narrative restructure of landing sections
- Changing auth API / validation logic
- Dark mode
- New illustration pipeline (reuse existing assets)

## Visual system

| Token | Value |
|--------|--------|
| Font | Plus Jakarta Sans |
| Page wash | `#F4F7FD` |
| Brand | `#1D4ED8` |
| Ink | slate-900 / slate-600 for body |
| Radius | 16–24px panels |
| Motion | fade/slide-up, stagger, hover; honor `prefers-reduced-motion` |
| Feedback | `react-hot-toast` (already global) |

Avoid: gradient-clipped mega titles, Inter as marketing face, app-store-only hero CTAs, browser `alert`/`confirm`.

## Shared components

1. **Marketing font layout** — home (+ optional auth layout) wraps Plus Jakarta like marketplace.
2. **`AuthShell`** — props: `role` (`student` \| `vendor` \| `admin` \| `generic`), `title`, `subtitle`, `children`, optional `footer`.  
   - Desktop: brand panel (logo, short line, soft blue wash / existing auth image treatment) + form column.  
   - Mobile: compact logo + form on wash.  
3. **Motion** — reuse/extend `FadeIn`; add scroll-reveal for home sections where useful.

## Home

**Order unchanged:** Hero → How it works → Deals → FAQ → Partner → Footer.

**Hero**
- Brand-forward header (logo primary).
- One headline + one supporting sentence (light rewrite of current).
- Primary CTAs: Browse deals → `/marketplace`, Sign up → `/auth/student/register`.
- App store buttons: footer or quiet secondary row (not hero primary).

**Sections**
- Replace giant gradient text titles with solid ink headings + short support line.
- How it works: 3 steps, light copy polish, stagger on scroll.
- Deals: keep collage; add link to marketplace.
- FAQ: same Qs, cleaner accordion on wash.
- Partner: vendor CTA retained; readable type on blue panel.
- Sticky header with subtle scroll treatment.

## Auth (all public)

Apply `AuthShell` to:

- Student: login, register, forgot, reset, verify-email  
- Vendor: login, register (+ steps), forgot, reset, verify-email  
- Admin: login, forgot, reset  
- Generic: `/auth/login`, `/auth/register`, `/auth/forgot-password`, `/auth/reset-password`, `/auth/update-password`

Preserve forms, validation, and redirects. Polish: staggered form entrance, clearer error blocks, consistent primary buttons, cross-links (student ↔ vendor where appropriate).

Role flavor (copy only):
- Student — campus deals / verify once
- Vendor — reach verified students
- Admin — quieter “Awoof Admin”

## Success criteria

- Home and auth feel continuous with marketplace/dashboard.
- Hero converts to web marketplace/signup first.
- No `window.alert` / `confirm` on these surfaces.
- Mobile and desktop both readable; reduced-motion safe.
