# Task 6 browser journey report

## Delivered

- Added passwordless Microsoft-handoff signup UI: server-held identity context, mailbox OTP, separately unchecked 18+/Terms/processing assent, passwordless session creation, and an explicit pending-enrollment label.
- Preserved the existing linked-account path and its safe continuation. Signup clears the handoff after the server commits it and never submits a password.
- Added optional recovery-code security and independent account-recovery routes. Generated recovery-code plaintext is React-memory display only; browser persistence contains only an opaque pending ID and operation name across the second fresh-auth redirect.
- Extended fresh reauthentication completion with server-derived purpose, pending-code ID, and target identity ID alongside its already-existing one-use grant. No client return URL or client-selected authority is accepted.

## Evidence

- RED: `npm run test:browser -- --grep 'unlinked Microsoft handoff|security setup keeps|independent password recovery'` failed before the routes/UI existed.
- GREEN: the same command passed 3/3 after implementation.
- `npx tsc --noEmit --incremental false` in `apps/web` passed.
- `npm run type-check` in `apps/backend` passed.

## Documentation impact

No public trust/help/privacy/developer copy was added: these routes are implementation-local, the passwordless signup flag/provider activation remains server-controlled, and browser mocks do not demonstrate live Microsoft, institution approval, or enrollment enforcement. The UI itself states that mailbox confirmation and school sign-in do not prove current enrollment or independently verify age. Public-page/claim-register review remains required before any production enablement.

## Remaining controller checks

The controller should run the full `npm run test:auth --prefix apps/web` and `npm run test:browser --prefix apps/web` suite. Focused tests use synthetic API routes only; they do not claim a live Microsoft redirect, mailbox delivery, provider policy approval, or production activation.
