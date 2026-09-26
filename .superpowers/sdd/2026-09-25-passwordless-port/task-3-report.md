# Task 3 report: passwordless handoff race regression

Implemented `link and signup completion racing for one verified handoff leave only the existing owner` in `apps/backend/src/testing/postgres/passwordless-signup.integration.ts`.

The test creates a real existing student owner with processing consent and a consumed `student_email` challenge, OTP-verifies the passwordless signup handoff, obtains a real link reauthentication grant, and runs `StudentSsoSignupService.complete` and `StudentSsoLinkService.link` with `Promise.allSettled` on that one handoff. It requires the owner link to be the only successful operation and verifies there is one user, one provider identity owned by that user, and one active session.

Validation: `npm run type-check` in `apps/backend` exited 0. The PostgreSQL integration suite was intentionally not run here, per task scope.

Documentation impact: runtime behavior is implemented but disabled by default;
it is neither deployed nor production-verified. Task 7 must update the public
trust/help/developer/OpenAPI inventory before any enablement claim. Checklist:
(1) signup/additional mailbox proof affects student and support journeys;
(2) no public pages updated because the flag remains false; (3) source/tests
are evidence only, deployment/provider activation pending; (4) Task 7 must
check links, labels, headings, keyboard access and mobile layout; (5) owner,
legal/operational and live-provider approval remain outstanding.

Follow-up production correction: migration 071 adds the dedicated
`student_sso_signup` OTP purpose, leaving legacy `student_signup` at its
existing ten-send/ten-minute contract. Its three-send/five-failure/five-minute
limits are still capped by the original handoff expiry.
