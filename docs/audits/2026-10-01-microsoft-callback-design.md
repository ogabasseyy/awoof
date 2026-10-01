# Awoof callback presentation review

Reviewed: 2026-10-01. Base: `origin/main` at `01181472b08b16d91aa32180d8ef15fbb2cc46ba`. Branch: `codex/awoof-microsoft-callback-design`. Status: source and local validation; merge, deployment and real-provider validation remain separate.

## Presentation

The existing Microsoft university-account completion and shared school-sign-in completion routes use `UniversityCallbackShell`: Awoof's existing logo, Plus Jakarta Sans, cobalt/pale colors, rounded controls and a graduation-cap-to-Awoof handoff motif. Both routes use university-account presentation without provider names or logos in the callback shell. The loading/Suspense view makes no student-enrollment success claim.

University-account connection, its enrollment outcome and the independent effective-eligibility refresh remain separate. Connection status/error copy now says "university connection"; enrollment result text and all actions remain unchanged. The school-email alternative still appears for a bound cancellation. Recovery management keeps its existing auth shell and explicit provider wording. Request handlers, callback/tab/session binding, expiry, retry, account-replacement fences and redirect timing were not changed. No new dependency or public route was added.

Provider transparency remains at the decision point: `MicrosoftVerificationCard.tsx` names Microsoft before connection, displays the versioned provider notice and requires its acceptance. Existing school-sign-in buttons identify the selected provider. The current `/privacy` content (`privacy-draft.ts`, sections `verification` and `recipients`) explains Microsoft/Google school sign-in and distinguishes school-account control from enrollment. This presentation is not a direct university integration or a claim of institutional approval, and cannot conceal the provider redirect or network endpoints from technical inspection.

## Checks

| Check | Result |
| --- | --- |
| Fresh dependencies | Web and backend Node 24 `npm ci` passed in the isolated worktree. |
| Web typecheck and production build | Passed. |
| Focused lint | Zero errors. The shared shell and Microsoft verification completion had zero warnings; six inherited SSO recovery warnings remain. |
| Existing school-sign-in browser suite | `npm run test:browser -- sso-login.spec.ts`: 18 passed, covering Google-linked assurance, linked/unlinked states, duplicate/late/expired completions, safe fallback and account replacement. |
| Existing HTTPS Microsoft callback cases | 16 selected tests passed, covering genuine Secure-cookie callback, missing/expired/mismatched tab state, replay, session replacement, identity-only versus enrollment results, bound cancellation and school-email fallback, terminal finish failure, independent status retry, explicit transient retry and held/late finish responses. |
| Local browser presentation | Loading, identity-only connected and restart/error views inspected. At 360px, no horizontal overflow, one h1 and controls at least 44px tall. Desktop inspected at 1440px; tablet checked at 768px. |
| Keyboard and reduced motion | Keyboard reached the Awoof home link with a visible cobalt focus ring. With reduced motion enabled, the loading icon's computed animation was `none` and the live status text remained available. |
| Existing link destinations | Home, privacy and terms returned HTTP 200 in the local fixture. |
| Focused read-only review | No confirmed actionable findings in the initial design or the fresh university-branding review. Authentication behavior unchanged; provider disclosure, eligibility copy and accessibility checked. |
| Whitespace | `git diff --check` passed. |

Screenshots were captured from the real components through the existing loopback synthetic visual fixture, without contacting Microsoft, a real institution, a database or external Awoof APIs. The loading capture held a synthetic finish request; only the Next development badge was hidden for that preview. Screenshot files under `output/playwright/` are local review artifacts, not production evidence or repository source.

The HTTPS browser suite uses the existing controlled provider/API fixtures; it is not a live Microsoft login or proof of institution activation. No backend/database behavior changed, so database suites were not repeated for this presentation change.

## Documentation impact

`docs/public-trust-pages.md` records the affected existing routes, source evidence and review owner. `/trust` and `/help` already explain account control versus enrollment; privacy, terms, partner/developer pages and legal schedules require no content change because processing, sharing, APIs, retention and commitments are unchanged. No new security guarantee, support contact, provider partnership or availability claim is made.

The original dirty checkout and the partner-readiness PR were preserved. No production configuration, provider activation or deployment was performed.
