# Server logout race follow-up

Concrete additional finding from the 2026-09-06 browser-session plan review. This is source evidence at c075f12, not a completed fix or live exploit claim.

`controllers/auth.controller.ts` calls `revokeSession(req.user.userId)` on logout. `services/auth/session.service.ts` clears the current durable refresh hash for that user without comparing the session that initiated logout. Consequently, a delayed logout from session A can clear the newer session B's refresh hash if the same user logs in again before A's revocation executes. The browser's stale-response guard cannot repair this server effect.

Current access tokens contain userId/email/role, with no server session binding. Refresh tokens have a random jwtid and a persisted token hash; `refreshSession` checks that hash but returns only a fresh access token, retaining the existing refresh token. The existing real PostgreSQL session tests prove replacement invalidates the old refresh token and revocation clears the current session, but do not prove old-logout-versus-new-login isolation.

Future bounded repair must distinguish ordinary logout of a captured session from intentional revoke-all operations such as password reset. Evaluate a server-bound session claim or authenticated matching refresh-token revocation contract before implementation; do not infer that the browser's new local envelope sessionId is authoritative. Require real SQL/HTTP tests for both transaction orderings, absent/forged/other-user identity, idempotent old-session logout, and password-reset revoke-all preservation. Do not expand current browser-source ownership or change the reviewed backend opportunistically.

Until that repair, browser-session results must describe local state/navigation protection only. A mocked browser race is not evidence of server session survival, and old stateless access-token expiry/revocation semantics must be stated honestly in the eventual release audit.
