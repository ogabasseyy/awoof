# Awoof repository instructions

## Keep public trust information synchronized

Every change affecting authentication, school-account verification, enrollment eligibility, consent, merchant data sharing, APIs/widget integration, personal-data handling, retention/deletion, security controls or support must assess its public-documentation impact in the same PR.

- Update the affected public pages and integration documentation alongside the implementation. If no update is needed, explain why in the PR summary. Documentation impact is part of completion, not optional follow-up.
- Maintain a public Security & Trust page at `/trust` when implemented. It complements, never replaces, privacy and terms pages. Link relevant pages from the public footer and student/partner journeys.
- Inspect current routes before introducing pages; extend existing pages rather than creating competing copies. Track planned and existing destinations in `docs/public-trust-pages.md`.
- Public copy must distinguish account login, school-account control and current enrollment eligibility. Never present an OTP, school email, Microsoft tenant or Google hosted account as authoritative current enrollment by itself. Verify actual enforcement before describing the enrollment-only design as shipped.
- Distinguish implemented source, tests, deployed/enabled behavior and planned features. Merged code or a plan does not prove production activation, institutional approval or merchant enforcement. Do not advertise unsupported universities, manual review, instant verification or integrations that are not operational.
- Publish only substantiated security claims. Never invent certifications, independent audit results, encryption coverage, uptime, response SLAs, privacy guarantees or regulatory compliance. Track each material claim with its code/config/test reference, deployment evidence where applicable, review date and responsible owner in an internal claim register. Do not expose sensitive evidence on public pages.
- Keep infrastructure addresses, secrets, raw logs, unresolved vulnerabilities, internal incident details and exploitable configurations out of public pages. Use only verified, monitored contact channels; do not invent `security@` or privacy addresses.
- Legal policy changes, new data-sharing commitments, vulnerability-testing permissions, safe-harbor language, bounty promises and public response deadlines require owner approval and appropriate legal/operational review. Do not copy competitors' policies or certifications.
- A status page must use real monitored service data, not a hardcoded green indicator. A supported-institutions list must reflect approved runtime capabilities, not seed-domain arrays. Do not add either until its data source exists.
- Preserve historical policy versions where needed. Set visible review dates only after a real content/evidence review, not automatically on each build.

### Required documentation-impact checklist

Include in each relevant PR:

1. User-visible behavior and affected trust/help/privacy/partner/developer pages.
2. Updated pages or an explicit no-change rationale.
3. Evidence for each added/changed claim, including whether deployment/partner activation is still pending.
4. Checks for working links and contact destinations, accurate UI labels, accessible headings, keyboard navigation and mobile layout.
5. Any legal/operational approvals or live-provider/merchant checks still outstanding.

For deferred pages, update the inventory and implementation brief without claiming the route exists. Do not block security fixes merely because legal review is pending: remove or narrow unsupported public claims, record the unresolved documentation requirement, and obtain approval before publishing new commitments.
