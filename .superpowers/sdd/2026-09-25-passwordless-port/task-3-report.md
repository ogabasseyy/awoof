# Task 3 report: passwordless handoff race regression

Implemented `link and signup completion racing for one verified handoff leave only the existing owner` in `apps/backend/src/testing/postgres/passwordless-signup.integration.ts`.

The test creates a real existing student owner with processing consent and a consumed `student_email` challenge, OTP-verifies the passwordless signup handoff, obtains a real link reauthentication grant, and runs `StudentSsoSignupService.complete` and `StudentSsoLinkService.link` with `Promise.allSettled` on that one handoff. It requires the owner link to be the only successful operation and verifies there is one user, one provider identity owned by that user, and one active session.

Validation: `npm run type-check` in `apps/backend` exited 0. The PostgreSQL integration suite was intentionally not run here, per task scope.

Documentation impact: none. This is test-only coverage with no user-visible behavior or public trust claim change.
