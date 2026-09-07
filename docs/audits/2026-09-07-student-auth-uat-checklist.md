# Student signup and login — hands-on test checkpoint

Status: **local synthetic success-path preview opened for owner testing** on2026-09-07. Both signup-plan tasks and Astra's final combined review are accepted at `280e25bd20ebd6e604b7245fa5642311e0bfbf67`, with independent34auth/89development/89production browser tests passing. The root production build is `bWvfdk85YCBkYN6lN1ldP` (54pages). No Critical/Important findings remain. The VPS has not received these changes.

## Open preview and dummy values

Use only the isolated Chrome window opened by the temporary preview command at `http://127.0.0.1:3107/auth/register?redirect=%2Fmarketplace%3Fsource%3Dsynthetic-preview`. It closes when that window closes or after60minutes. An ordinary browser tab does not inherit the fixture routes. Runtime PTY32750; helper `/private/tmp/awoof-auth-preview-XHOqBe/auth-preview.mjs` with usage in that directory's README. This is a local Mac test, not a shared staging site or phone-accessible preview.

Choose **Continue as a student** and use only these public synthetic fixtures:

| Field | Dummy value |
| --- | --- |
| Full name | Synthetic Student |
| Student email | student@alpha.approved.test |
| University | Approved Alpha University (AAU) |
| Password and confirmation | Synthetic!Pass9 |
| Matric number | Leave blank |
| OTP | 123456 |

Give processing consent, Continue, then enter the dummy OTP and Create Account. This manual fixture models success, not real authentication: it does not reject every valid-format incorrect OTP or arbitrary body before returning its programmed response. Use exact values. Error/recovery/race scenarios below were exercised by the automated regression suite with specifically programmed responses, not enabled as arbitrary manual scenarios in this preview. No email is sent and no real account is created.

The headed readiness check confirmed expected chooser control, matching local URL, nonempty page title, no framework overlay marker and healthy fixture/page/console state before reporting opened. Root also ran the final harness headlessly through chooser → signup → consent → OTP → safe marketplace, exit0. Screenshots/video/traces/DOM dumps were intentionally disabled. Installed isolated Chrome1280x900 was used for this preview; regression tests also include desktop/mobile keyboard cases. Current test-timing Minor S5 is deferred: short cooldown deadlines created before UI setup can cause a false failure on a slower machine; do not mask such failures with retries.

## What the first test covers

This is a bounded student signup/login test, not full-project launch approval. It checks approved-school-email support, explicit processing consent, OTP interaction, honest error/recovery messages, safe navigation and desktop/mobile keyboard access. It does not prove university partnerships, production email delivery, merchant discount redemption or Paystack.

A local synthetic preview uses dummy data and intercepted responses; it cannot verify delivery of a real OTP. A real end-to-end staging test needs a separate confirmed environment, current migrations, an explicitly approved test institution/domain and configured email delivery. Neither mode changes the production VPS implicitly.

## Broader checklist (programmed error scenarios require the automated harness or later staging)

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

The first four gates above are complete for the bounded local success-path preview only. All reports and branches remain preserved unmerged. No push, CI run, deployment, live email or provider operation is implied.
