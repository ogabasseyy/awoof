# [DRAFT — UNPUBLISHED] Proposed Cookie & Browser-Storage Notice Amendments: Profile Deferral Marker

> **IMPORTANT NOTICE:**  
> **Status:** UNPUBLISHED DRAFT ONLY.  
> **Legal Notice:** This document is internal preparatory material for owner and legal review. It has NOT been approved by legal counsel or the business owner, has NOT been published to any public route (`/cookies`), is NOT indexed by search engines, and must NOT be cited as effective public terms.  
> **Effective Policy:** The effective public Cookies and Browser Storage Notice remains version 1.0 at `/cookies`.

---

## 1. Context of proposed amendment
This draft documents the prospective browser-storage disclosure required before activating the optional academic-profile completion feature (`ACADEMIC_PROFILE_ENABLED=true`). It provides technical transparency regarding the client-side session storage mechanism used when students choose "Complete later".

---

## 2. Proposed section: Academic profile completion deferral marker

| Property | Specification |
|---|---|
| **Storage Mechanism** | Browser `localStorage` (with graceful in-memory fallback if storage is blocked or full) |
| **Storage Key Pattern** | `awoof.profile.defer-prompt.v1.<browserSessionId>` |
| **Stored Contents** | The authenticated user's opaque Account ID (UUID) only. |
| **Excluded Contents** | **NEVER** stores passwords, session tokens (JWTs), refresh tokens, form drafts, course choices, graduation years, or identity-provider responses. |
| **Primary Purpose** | User experience optimization and prompt suppression. When a student chooses **Complete later** on the academic profile screen, this marker informs other tabs in the same authenticated browser session that the invitation was deferred, preventing disruptive popups or repeated prompts during browsing. |
| **Legal Classification** | Functional / Preferences storage (necessary to respect the user's explicit choice to skip an optional prompt). |
| **Lifetime & Eviction** | - Tied strictly to the authenticated `browserSessionId`.<br>- Automatically cleared upon user logout or session invalidation.<br>- Cleared immediately if an account mismatch is detected upon session refresh.<br>- Stale markers from closed or superseded sessions are pruned opportunistically. |
| **User Controls** | Clearing browser storage or website data clears the deferral marker. Doing so will simply allow the skippable invitation to be shown again on your next eligible login. |

---

## 3. Storage safety guarantees
1. **No cross-account leakage:** Because the key includes the unique `browserSessionId` and the value contains the `accountId`, an older tab or a new sign-in by a different user cannot read or inherit a prior user's deferral choice.
2. **Fail-safe degradation:** If `localStorage` access is denied (e.g. strict private browsing or disabled cookies), the application falls back to an in-memory marker for the active tab. Prompting does not enter an infinite loop.
3. **No network transmission:** This marker exists solely within the browser client; it is never transmitted in HTTP headers, request bodies, or analytics pings.
