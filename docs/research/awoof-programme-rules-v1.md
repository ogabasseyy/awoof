# Awoof-owned programme duration rules v1

**Date:** 2026-10-20
**Status:** Reviewed and enabled (`awoof-owned-v1`)
**Artifact:** `apps/backend/src/data/academic-programmes/awoof-v1.normalized.json`

## Why this exists

The NUC-derived reference (`nuc-v2.normalized.json`) remains withheld:
all 237 rows are blocked with `content_withheld_pending_licence` and
`redistributionAllowed: false` (see `nuc-programme-licensing-review.md`).
Graduation estimates therefore always reported `unreviewed_rule`.

On 2026-10-20 the owner chose to enable estimates from Awoof-owned rules
instead of waiting for the NUC licence. No NUC content (programme lists,
source IDs, or register durations) was used to build this artifact.

## Rule basis

Durations are the standard full-time programme lengths in Nigerian
universities, as publicly structured by award type:

- 4 years: most B.Sc./B.A. programmes (sciences, social sciences,
  management sciences, computer science, architecture).
- 5 years: LL.B. Law, B.Eng. engineering, B.Agric., Nursing (B.NSc.),
  Pharmacy (B.Pharm.), Medical Laboratory Science, Physiotherapy,
  Radiography, Estate Management, Quantity Surveying, Building.
- 6 years: Medicine (MBBS), Dentistry (BDS), Veterinary Medicine (DVM).

Direct-entry routes consume the reviewed *remaining* duration, matching
the estimator contract: `de_200` is the UTME duration minus one year and
`de_300` minus two years (minimum one). `transfer_other` is marked
non-estimable because transfer placement varies by institution.

## Review and change control

The 36 programmes in v1 were reviewed by the business owner on
2026-10-20. Adding a programme or changing a duration requires a new
artifact version (`awoof-owned-v2`, ...) so stored estimate bases keep
naming the rule version they were calculated from. Estimates remain
advisory only and are never proof of enrollment (Privacy Notice v1.2).
