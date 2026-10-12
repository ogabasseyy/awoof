# Student registration-number formats and entry-year parsers

Date: 10 October 2026
Status: research lead only; no parser is enabled for production suggestions.

## Scope

This note records the evidence position for the optional matric-number entry-year
suggestion used by the student academic profile. A parser may return a suggested
year only when it is institution-specific, source-reviewed, versioned, and listed
below as enabled. Unreviewed formats return `unavailable`, never a guessed year.
All examples in this document are synthetic and clearly marked; no real student
registration numbers appear here or in tests.

## Parser status

| Institution key | Parser ID | Version | Confidence | Status |
|---|---|---|---|---|
| (none) | (none) | (none) | (none) | No parser enabled |

The production parser registry (`REVIEWED_MATRIC_PARSERS` in
`academic-entry-year.service.ts`) is intentionally empty. Every projection
suggestion is therefore `null` (parser not enabled for the current context)
until a parser completes the review checklist below.

## Research leads (unreviewed, disabled)

### UNILAG two-digit prefix lead

- Lead: a two-digit admission-year prefix was mentioned as a possible University
  of Lagos matric-number convention. This is an unverified research lead, not an
  approved parser.
- Evidence held: none. No primary source (official student handbook, published
  matric-number specification, or registrar-confirmed sample format) has been
  recorded, so no UNILAG parser exists and no prefix rule is implemented.
- Synthetic illustration of the *shape* under investigation (SYNTHETIC ONLY, not
  a real UNILAG number, not evidence): `TST/14/0001`-style `PREFIX/YY/SEQUENCE`.
  Unit tests use this synthetic shape with a test-only parser to prove the
  century-window and exact-match machinery; the test parser is never registered
  for production.
- Required before enabling: a primary source link plus a recorded source
  version/date, at least two corroborating format samples from that source
  (redacted to structure only), the documented two-digit-year-to-century window
  with its ambiguity rule, and passing parser tests pinned to that evidence.

## Candidate sources to verify (not yet reviewed)

These are places to look, not evidence. Nothing below has been checked or
confirmed:

- The institution's official student handbook or admissions pages describing the
  registration-number structure.
- Registrar-published matric-number guidance or verified help-desk documentation.
- Institution-issued sample documents that display the number structure.

## Parser review checklist

A parser moves from lead to enabled only when all of the following hold:

1. Institution-specific: the parser matches one documented school format only.
   Universal, multi-school, or substring-only matchers are never accepted.
2. Source-reviewed: primary source links, source version/date, and the exact
   matched structure are recorded in this note.
3. Versioned: the parser carries a stable `parserId` and `parserVersion`, and
   any format change ships as a new version with updated evidence.
4. Century-windowed: the parser defines its two-digit-year-to-century window
   (maximum plausible age and current-year cap). Years plausible in two
   centuries return `ambiguous_format`; years plausible in none return
   `unrecognized_format`.
5. Exact: matching is anchored full-string only. Case, separators, and digit
   counts follow the source; surrounding whitespace may be trimmed.
6. Confidence-documented: `high`, `medium`, or `low` is set from the source
   evidence, never upgraded by the service.
7. Tested: unit tests pin the exact format, unsupported institutions, missing
   numbers, unrecognized and ambiguous inputs, century boundaries, and the
   no-persistence/no-logging guarantees.
8. Suggestion-only: parsed years are returned as suggestions. The student
   confirms or edits the year before it becomes `entryYear`; the service never
   auto-saves and never re-suggests over a stored answer.

## Disclosure and handling

- Registration numbers used for parsing come only from the locked server-side
  student context, never from HTTP input. They are never returned in
  projections, never logged, and never placed in URLs.
- Enabling a parser does not verify enrollment. Suggestions remain advisory
  profile input with the same non-eligibility guarantees as other academic
  fields.
