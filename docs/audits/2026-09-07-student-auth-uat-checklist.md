# Student signup and login — hands-on test checkpoint

Status: **not yet handed over for testing**. The signup core is accepted at `7501746e5c29f2f9bc5e6163764331f0e52a55a5`; the entry/login/password-control task is still being implemented and reviewed. The VPS has not received these changes.

## What the first test covers

This is a bounded student signup/login test, not full-project launch approval. It checks approved-school-email support, explicit processing consent, OTP interaction, honest error/recovery messages, safe navigation and desktop/mobile keyboard access. It does not prove university partnerships, production email delivery, merchant discount redemption or Paystack.

The test address and exact reviewed build will be supplied only after the remaining checks pass. A local synthetic preview uses dummy data and intercepted responses; it cannot verify delivery of a real OTP. A real end-to-end staging test needs a separate confirmed environment, current migrations, an explicitly approved test institution/domain and configured email delivery. Neither mode changes the production VPS implicitly.

## Short owner checklist

1. Open the account entry page. Choose Student; Vendor must remain a separate route. Student entry should lead to the school-email proof form rather than a generic role/password form.
2. Enter student details and choose the institution. School-email support must not say identity is already verified. Read the processing notice and give consent explicitly. Changing the email, institution, name or registration details must require a fresh consent action where those claims change.
3. Request a code. Keyboard focus should move to the six-digit code field. Check incorrect/incomplete code feedback, then the valid-code path. Resend must respect its cooldown and clear the old proof; Back should return to editable details and discard the pending proof.
4. Check sign-in/signup links and the intended return page. A successful signup/login must stay within the allowed Awoof destination. An uncertain server outcome should offer honest sign-in recovery rather than repeatedly creating the account.
5. Repeat the essential flow on a narrow/mobile screen. Use Tab, Space and Enter: both password visibility controls should be reachable, named Show/Hide password and usable without submitting the form. Controls should be disabled while login is submitting, and Enter on the password field should submit once.

For a problem report, record the screen/step, expected versus actual behavior, approximate time, and the reviewed build identifier. Do not include passwords, OTPs, tokens or screenshots containing those values.

## Handoff gate

- Task2 implemented and frozen with explicit source commit.
- Independent covering checks and browser tests against a fresh production build passed.
- Astra task review and the combined signup-plan review completed; outstanding findings stated explicitly.
- Test environment and limitations confirmed, test address actually reachable, no live-data side effects hidden behind a synthetic preview.
- Larger verification-status, merchant/widget, privacy/admin and release work remains separately tracked.
