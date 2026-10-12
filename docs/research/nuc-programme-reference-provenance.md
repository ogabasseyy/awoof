# NUC programme-duration reference provenance

Status: **blocked pending licence and provenance clearance; calculations disabled.**

This is an INTERNAL provenance record for the programme-duration reference
used by the student-profile completion feature. It records source identity,
licence position, and row disposition. It contains no programme labels,
durations, or exception-note content. No redistribution of workbook-derived
content is authorized by this note.

## Source identity

- Workbook: `NUC_Programme_Durations_2026-10-02_v2.xlsx`
- Review date stated in workbook: 2 October 2026
- Workbook self-description (paraphrased): an independent NUC CCMAS
  reference compilation; explicitly not NUC-certified.
- SHA-256: `fc0e27a0dd320da5de75c98a2082c302e5b71af1cfa2ee734a10ceb01855f7a2`
  (verified read-only with `shasum -a 256`; the original file was not modified)
- Source version recorded in artifacts: `NUC_Programme_Durations_2026-10-02_v2`

Sheet inventory (header row + data rows, read-only inspection):

| Sheet | Rows | Role |
|---|---|---|
| Read Me | 30 | Coverage counts, methodology legend, workbook guide |
| Nigeria Register | 238 (237 data) | Nigerian programme-duration compilation |
| Evidence Notes | 238 (237 data) | Per-row interpretation, PDF page locators, cross-check URLs |
| Exceptions | 57 | Conflict, variant, legacy, and unresolved-route annotations |
| Sources | 33 (32 records) | Source register with URLs and use/limitation notes |
| Ghana Examples | 4 (3 examples) | Institutional examples only, not a register |
| Later Offerings | 2 (1 row) | Single institution-reported programme outside the public summary list |

Row identity: the Nigeria Register uses opaque serial IDs `NG001`–`NG237`,
verified contiguous and unique, with sheet row = serial + 1. The runtime
artifact accounts for every one of these IDs exactly once.

Locator convention: PDF-viewer page numbers recorded per row, plus a primary
`Source ID` and optional cross-check IDs. Page locators are required for any
row to be considered reviewable.

## Workbook conventions affecting the importer (paraphrased)

- Evidence vocabulary: general discipline rule, programme-specific,
  mixed programme/general, partly derived from stated entry level, variant
  referenced, conflicting text, legacy pathway, and UTME-verified with DE
  unresolved. The exact compound pending marker must be detected; an exact
  match on a bare unresolved marker alone misses it.
- Display duration fields and fixed numeric fields are distinct. Numeric
  columns are blank for variants and unresolved values; blanks must never
  become zero, and DE years must never be guessed from credits.
- Years count academic degree duration from the stated admission route.
  Post-degree stages (national service, internship, housemanship,
  professional school, separate master's stage) are not added.
- DE 200-level and DE 300-level are different routes with separate review.
  "Not established" means not verified in the compilation, not prohibited.
- The 237-row count is the compilation's count (it retains award pathways,
  overlaps, and aliases), not an asserted official national total.

Aggregate evidence-code profile of the 237 register rows (counts only, no
programme content): G 165, P/G 40, P 15, C 7, V 4, P/R 3, P/U 2, L 1.

## Primary sources (bibliographic citations, reviewed 2026-10-02)

The 17 NUC CCMAS discipline standards plus the live NUC library index:

| ID | Title | URL |
|---|---|---|
| N00 | NUC live CCMAS library | https://www.nuc.edu.ng/ccmas/ |
| N01 | NUC CCMAS: Administration and Management | https://www.nuc.edu.ng/wp-content/uploads/2026/03/Administration-and-Management.pdf |
| N02 | NUC CCMAS: Agriculture | https://www.nuc.edu.ng/wp-content/uploads/2026/03/Agriculture-2023.pdf |
| N03 | NUC CCMAS: Allied Health Sciences | https://www.nuc.edu.ng/wp-content/uploads/2026/03/Allied-Health-Sciences-2023.pdf |
| N04 | NUC CCMAS: Architecture | https://www.nuc.edu.ng/wp-content/uploads/2026/03/Architecture-CCMAS-2023-FINAL.pdf |
| N05 | NUC CCMAS: Arts | https://www.nuc.edu.ng/wp-content/uploads/2026/03/Arts-CCMAS-2023-FINAL.pdf |
| N06 | NUC CCMAS: Basic Medical Sciences | https://www.nuc.edu.ng/wp-content/uploads/2026/03/Basic-Medical-Sciences-CCMAS-FINAL-December-26-2022.pdf |
| N07 | NUC CCMAS: Computing | https://www.nuc.edu.ng/wp-content/uploads/2026/03/Computing-CCMAS-2023-FINAL.pdf |
| N08 | NUC CCMAS: Communication and Media Studies | https://www.nuc.edu.ng/wp-content/uploads/2026/03/Communication-and-Media-Studies-CCMAS-2023-FINAL.pdf |
| N09 | NUC CCMAS: Education | https://www.nuc.edu.ng/wp-content/uploads/2026/03/Education-CCMAS-2023-New.pdf |
| N10 | NUC CCMAS: Engineering and Technology | https://www.nuc.edu.ng/wp-content/uploads/2026/03/Engineering-Technology-CCMAS-2023-FINAL.pdf |
| N11 | NUC CCMAS: Environmental Sciences | https://www.nuc.edu.ng/wp-content/uploads/2026/03/Environmental-Sciences-CCMAS-2023-FINAL.pdf |
| N12 | NUC CCMAS: Law | https://www.nuc.edu.ng/wp-content/uploads/2026/03/Law-ALL.pdf |
| N13 | NUC CCMAS: Medicine and Dentistry | https://www.nuc.edu.ng/wp-content/uploads/2026/03/Medicine-and-Dentistry-CCMAS-2023-FINAL.pdf |
| N14 | NUC CCMAS: Pharmacy and Pharmaceutical Sciences | https://www.nuc.edu.ng/wp-content/uploads/2026/03/Pharmacy-and-Pharmaceutical-Sciences-CCMAS-2023-FINAL.pdf |
| N15 | NUC CCMAS: Sciences | https://www.nuc.edu.ng/wp-content/uploads/2026/03/Sciences-CCMAS-2023-FINAL.pdf |
| N16 | NUC CCMAS: Social Sciences | https://www.nuc.edu.ng/wp-content/uploads/2026/03/Social-Sciences-CCMAS-FINAL-2023-A.pdf |
| N17 | NUC CCMAS: Veterinary Medicine | https://www.nuc.edu.ng/wp-content/uploads/2026/03/Veterinary-Medicine-CCMAS-2023-FINAL.pdf |

Supporting records: X01–X07 (NUC notices and university cross-checks),
M01 (institutional mirror of Education CCMAS), S01 (secondary inventory
cross-check retained for provenance only), N18 (repository copy corroborating
Education CCMAS provenance), and G01–G04 (Ghana regulator and university
sources for the three institutional examples). Full URLs are in the workbook
Sources sheet; they are reached through the controlled acquisition procedure
below, not through a developer's personal folder.

Source-use caveats (paraphrased): locators use PDF-viewer page numbers; an
upload path date is not proof of a curriculum revision; internet cross-checks
are targeted, not universal; cross-check IDs include regulator updates and are
not all independent university confirmations.

## Licence and redistribution position

- The workbook carries **no licence, redistribution, or attribution
  statement** (Read Me and Sources limitation notes inspected in full).
- The upstream NUC CCMAS PDFs carry a licence notice that search-visible
  text associates with a CC-BY-family licence applying to the publication's
  text content, with permission contact `publication.copyright@nuc.edu.ng`.
  The exact licence variant and scope could not be confirmed from the
  review environment, and no permission covering this workbook compilation
  or its redistribution in this repository was located.
- Conclusion: the redistribution position is **unclear**. Per the plan, no
  source-derived rows are packaged: every register row is classified
  **blocked**, and graduation-year calculations stay **disabled** until
  authorized provenance is recorded.

## Disposition

- All 237 Nigeria Register rows (`NG001`–`NG237`): blocked. The runtime
  artifact `apps/backend/src/data/academic-programmes/nuc-v2.normalized.json`
  carries only opaque source IDs, sheet/row locators, and block reasons.
  `calculationsEnabled` is `false`; the estimate service must refuse to
  calculate from this artifact.
- Ghana Examples and Later Offerings: out of scope for the Nigerian
  reference (examples/single reports, not registers). No Ghana rule may be
  derived from them.
- Exceptions and Evidence Notes: annotation layers. Their flags (conflict,
  variant, legacy, derived, award caveat) fold into per-row exclusion
  reasons at review time; while blocked, no annotation content is copied
  into the repository.
- Tests use small synthetic fixtures only. No real student numbers appear
  in this note.

## Controlled acquisition procedure (no Downloads dependency)

Builds and tests never read a developer's personal folder. To re-verify:

1. Obtain the workbook through an access-controlled, owner-approved
   location (never commit the workbook itself).
2. Verify `shasum -a 256` equals the hash recorded above.
3. Confirm the Nigeria Register still holds contiguous IDs `NG001`–`NG237`
   before regenerating any extract.

## Clearance checklist for future inclusion

1. Record the exact upstream licence variant and its scope from the CCMAS
   licence page, plus written compiler permission for this compilation.
2. Record attribution requirements and where they are surfaced.
3. Re-run the importer with redistribution allowed over a controlled
   extract, keeping every row's classification reviewable.
4. Keep route-specific review: UTME approval never approves an unresolved
   DE counterpart, and imported labels/numerics alone are never approval.
