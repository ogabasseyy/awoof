# Microsoft university onboarding and release runbook

## Status and operating boundary

This runbook describes the implemented local Microsoft verification feature and the evidence required before any university use. It is not proof that Awoof has a university integration, Microsoft tenant approval, a deployment, an active scheduler, a backup, or a school pilot.

Microsoft issuance is globally off by default and every institution is unapproved by default. Do not turn that configuration into an assertion that a school has approved Awoof. A Microsoft sign-in establishes a Microsoft identity connection only; it is not current-enrollment evidence and it must never override an authoritative denial. Until the institution policy, enrollment semantics, and approval are recorded, treat Microsoft as **identity-only/off**.

| Required release-artifact evidence | Current status |
| --- | --- |
| Exact candidate commit SHA | **NOT YET CERTIFIED** |
| Immutable artifact digest | **NOT YET CERTIFIED** |
| Applied schema/migration record for that artifact | **NOT YET CERTIFIED** |
| Clean-archive, source-absent artifact rehearsal | **NOT YET CERTIFIED** |
| Authorized staging tenant and test-account evidence | **NOT YET CERTIFIED** |
| Explicit deployment authority and actual pilot evidence | **NOT YET CERTIFIED** |

Do not fill these fields from a dirty checkout, a local source test, a browser fixture, or an inferred school email domain.

## 1. Obtain institution authority before configuration

An authorized university IT/security contact—not an email-domain lookup—must supply and approve the following record before Awoof records a tenant or enables a policy:

- Microsoft tenant ID and the university/IT contact who verified it.
- The approved Awoof use case and data roles: processor/controller status, retention/contact expectations, consent approver, and incident/revocation contacts.
- Which accounts are current students, staff, alumni, guests, service accounts, and disabled accounts. A staff/student-looking email address is not a role decision.
- Whether Microsoft Graph Education data is available and authorized, which current-enrollment signal is authoritative, the academic-term boundary, SIS/SDS or other lifecycle update cadence, and withdrawal/transfer/disable semantics.
- The approved-until date, the school update cadence, agreed recheck interval, and the measured maximum revocation-detection latency. These are school-specific values to record, not defaults to invent.
- Authorized, non-production test accounts for a current student; staff; alumnus; guest; disabled account; and negative/unknown enrollment case. Record the account owner authorization and expiry, not passwords or raw identity values.

If any item is absent, do not imply that enrollment can be determined. Keep the institution identity-only or disabled and retain the existing school-email route where it is independently valid.

### Institution record checklist

Record the following in the approved change/release evidence, with references to the IT authorization rather than secrets:

| Field | Required recorded value |
| --- | --- |
| Institution and verified tenant ID | IT-supplied UUID; never inferred from an email suffix |
| Policy owner and consent approver | Named authorized roles and contact path |
| Mode | `identity_only` or approved `graph_enrollment` |
| Role/lifecycle mapping | Student, staff, alumni, guest, disabled, unknown, term end, and withdrawal meaning |
| Update/recheck agreement | Source, cadence, measured recheck/revocation latency, evidence owner |
| Approval validity | `approved_until`; graph mode also has a future term boundary |
| Evidence lifetime | Chosen `max_evidence_hours` value (the implemented policy permits 1–24 hours) |
| Notice and consent version | Exact published notice/policy versions accepted for the institution |
| Test-account authorization | Account class, owner approval, expiry, and expected outcome; no credentials |

## 2. Configure the Awoof-controlled application

Only Awoof registers and operates the application. A university must not give Awoof a school password, a shared administrator login, a tenant-wide credential, or an unscoped roster export. Provision the Awoof client ID, client secret, and attempt-encryption key through the approved secret store with least access and rotation/audit ownership; never paste any of them into tickets, runbooks, shell history, logs, browser storage, or source control.

Read the active configuration and policy before declaring a tenant, scope, mode, or expiry. The implemented configuration accepts these inputs:

- `MICROSOFT_OIDC_ENABLED` is `false` by default.
- Enabling it requires the Awoof client ID/secret, callback URL, and frontend completion URL. The tenant identifier must be a UUID when supplied.
- The callback is fixed at `https://<Awoof API origin>/api/verification/microsoft/callback`; the completion route is fixed at `https://<Awoof frontend origin>/student/verification/microsoft/complete`. Both must be credential-free HTTPS URLs, have no query/hash, and be same-site. `FRONTEND_URL` must match the configured completion origin.
- Institution policy stores the IT-supplied tenant ID, enabled state, mode, approval expiry, term boundary where required, evidence cap, canonical scopes, policy version, and notice version. A graph-enrollment policy cannot be enabled without a current approval and future term boundary.

### Least-privilege scope request

Request only a scope set the server accepts and only for the approved policy mode:

| Mode | Implemented request scopes | Enrollment result |
| --- | --- | --- |
| `identity_only` | `openid`, `profile` | Identity connection only; no enrollment evidence |
| `graph_enrollment` | `https://graph.microsoft.com/EduRoster.ReadBasic`, `openid`, `profile` | A bounded enrollment observation only when the institution policy and current consent authorize it |

Do not request `offline_access`, broad directory reads, write permissions, unscoped Graph access, or any extra scope on the assumption it might help later. The Graph token is used in memory for the authorized observation; it is not a stored user credential or route response.

## 3. Consent, identity, enrollment, and lifecycle handling

### Keep the three concepts separate

1. **Processing grant** is the parent verification-processing consent. It is required by both independent school-email verification and Microsoft verification. Withdrawing it revokes all verification evidence dependent on that grant, including independent email evidence.
2. **Microsoft provider consent** is separate from that parent grant. It snapshots the Microsoft provider policy version, notice version, mode, and scopes for a connection attempt.
3. **Merchant disclosure** is a separate merchant/origin/purpose consent. It is required separately for merchant assertion/benefit use; neither processing nor Microsoft provider consent substitutes for it.
4. **Microsoft identity** is a tenant/object identity connection to the Awoof account. It does not prove the person is a current student.
5. **Enrollment evidence** exists only after an authorized `graph_enrollment` observation passes the institution policy. Unknown, unavailable, staff, alumni, guest, disabled, or unauthorized results do not become enrollment evidence.

The existing student-email route's configurable default is 90 days; this is not a Microsoft-evidence lifetime. The actual Microsoft enrollment-evidence expiry is `MIN(observed_at + 24 hours, observed_at + max_evidence_hours, term_ends_at, approved_until)`. `max_evidence_hours` is a configured 1–24-hour policy value, and graph mode requires the school-approved term boundary. Do not convert a Microsoft identity, a fresh email, or a successful callback into a longer lifetime by inference.

### Withdrawals and unlink are different operations

- **Withdraw processing grant:** withdraws the parent verification grant and revokes every dependent verification result, including independently verified school-email evidence. It is not a narrower Microsoft-only operation.
- **Withdraw Microsoft provider consent:** stops unfinished Microsoft verification and revokes dependent Microsoft proof. It preserves independently verified school-email evidence and merchant disclosure, which are separate grants.
- **Explicit owner identity unlink:** a valid owner session may unlink an opaque Microsoft identity even while issuance or the institution policy is off. This cancels live attempts and revokes dependent Microsoft proof/evidence while preserving independent school-email proof and merchant/audit receipts.

Unlink leaves a durable revoked-identity tombstone. It does not silently relink, restore, transfer, or reuse the identity. The current recovery result is `support_required`; use the authorized support path for any new identity/recovery decision. Do not delete the tombstone to make a retry succeed.

### Session and inactive-account limitations

Microsoft start/callback/finish requires a current student user, a live server-side session ID, an unexpired stored refresh session, and an active student profile for issuance. Legacy sessions without the new session binding must sign in again before Microsoft use.

Owner history, provider-consent withdrawal, and identity unlink use the owner session path: an inactive student profile may use those controls only while its already-issued, exact server session remains live (matching session ID, stored refresh hash, and refresh expiry). Ordinary sign-in/session issuance and refresh require an active profile. Once that session expires, an inactive owner has no promised self-service login or refresh recovery path. A deleted, suspended/revoked, unregistered, or otherwise inactive account must use the authorized recovery/support process; after recovery it still needs a fresh session and applicable consent.

## 4. Authorized staging rehearsal

Do not contact Microsoft or a university tenant until the staging authorization and test-account record above are approved. In the authorized staging tenant, perform and record these cases with redacted correlation IDs and timestamps:

| Fixture | Required result |
| --- | --- |
| Current student | Only succeeds as enrollment when the approved policy and authoritative school lifecycle signal permit it |
| Staff | Identity may connect if authorized; no new student enrollment eligibility |
| Alumnus | No new current-enrollment eligibility |
| Guest | No new current-enrollment eligibility |
| Disabled account | No new enrollment evidence or issuance |
| Unknown/unavailable enrollment | Identity-only/off; no invented roster result |
| Consent denied/withdrawn | Safe fallback remains usable; no Microsoft issuance |
| School revocation/term withdrawal | Detected within the agreed, measured window; dependent Microsoft eligibility fails closed |

For each rehearsal record the expected and observed policy decision, policy/notice version, authorization expiry, recheck time, and elapsed revocation latency. Redact tenant/object IDs, tokens, authorization codes, PKCE values, cookies, emails, and provider payloads.

## 5. Diagnostics, retention, and operational cleanup

Diagnostics are redacted, measured attempt timelines. They can show that Awoof observed stages such as start, callback, token validation, education response, policy decision, and finish; they do **not** prove that the university certified enrollment. Preserve only safe correlation and outcome information in operational evidence.

The implemented cleanup service uses transactional, `FOR UPDATE SKIP LOCKED` batches of at most 500 attempts and 500 diagnostic events per invocation:

- expired pending/processing/ready attempts are terminalized and their callback/PKCE/finish/result material is scrubbed;
- terminal callback/PKCE material is removed, while a completed receipt/finish material remains only through the attempt's original expiry needed for the bounded retry behavior;
- redacted diagnostic events older than 30 days are deleted in separately bounded batches;
- attempt, independent email, merchant, evidence provenance, audit, and revoked-identity tombstone records are not broadly deleted by this cleanup.

There is **no automatic Microsoft cleanup scheduler installed**. An hourly schedule is a future deployment decision requiring explicit approval, the deployed artifact, target-specific monitoring, and failure escalation. Do not treat a local canary or an ad-hoc CLI invocation as scheduler evidence.

### Current commands and safe local rehearsals

Run only from the backend directory and only with the repository's guarded local test configuration. These commands use the implemented package/control scripts and must never be pointed at a university tenant or production database during local rehearsal:

```sh
cd /Users/mac/.codex/worktrees/f242/Awoof/apps/backend
npm run build:artifact
node scripts/artifact-runtime-control.mjs --postgres
node scripts/artifact-runtime-control.mjs --disabled-fallback-smoke
```

The runtime controls create a temporary source-absent runtime with Microsoft disabled and use its fixed local/disposable PostgreSQL harness. They are local artifact evidence only. Record exit status, exact build input, manifest output, and any explicit skip; do not call a skipped test a pass.

`npm run microsoft:cleanup:prod` is the existing compiled cleanup entry (`node dist/scripts/cleanup-microsoft-attempts.js`). It is not a local rehearsal command and must run only after explicit target/database authority, with approved bounded operational procedure and no sensitive output capture. Its output is limited to counts on success or a fixed redacted failure line; it does not install a scheduler.

## 6. Release gates

Each gate is distinct; succeeding at one does not satisfy a later one.

| Gate | Required evidence | Does not prove |
| --- | --- | --- |
| Local synthetic checks | Focused/unit/PostgreSQL/browser results, source-absent artifact results, exit codes, and explicit skipped tests | University approval, real tenant behavior, deployment, or pilot |
| Independent code/security review | Review of the exact implementation and release/rollback procedure | A staging authorization or live production safety |
| Authorized staging tenant | IT approval, approved accounts, role/lifecycle fixtures, redacted measured recheck/revocation results | Deployment authorization or actual university pilot |
| Explicit deployment authorization | Authorized target, migration rehearsal, certified artifact, backup/recovery and operational owner evidence | A completed school pilot |
| Actual school pilot | Authorized pilot cohort and observed student/staff/alumni/guest/disabled/lifecycle behavior | Broader rollout approval |

VPS proxy access/error-log masking and backup/recovery arrangements remain deployment prerequisites until separately evidenced on the authorized target. Local canaries do not certify live log masking, worker inventory, proxy configuration, backups, or restore capability.

## 7. Rollback and issuance-off procedure

Do not roll back to a pre-Microsoft reader after Microsoft evidence exists. The rollback target must be an immutable, exact-SHA/digest Microsoft-aware artifact that understands the current schema, session authority, provider proof/consent checks, independent email fallback, withdrawal/history/unlink, and bounded cleanup while issuance is off. At present the required artifact SHA and digest are **NOT YET CERTIFIED**; therefore Microsoft must remain off and a reviewed forward repair is the only permitted recovery path.

When an artifact is certified and deployment authority exists, record its exact SHA, digest, migration/schema record, build provenance, and worker inventory in the execution report before use. Then perform this ordered procedure:

1. Turn Microsoft issuance off before accepting new starts or callbacks that could collect data. Preserve owner history, withdrawal, unlink, and cleanup access for valid sessions.
2. Verify that no remaining API, queue, cron, or worker process can issue Microsoft proof. Do not use a process-health response as eligibility proof.
3. Boundedly drain or cancel pending Microsoft attempts. Record the attempt count and terminal outcome without secrets or provider payloads.
4. Switch only to the certified Microsoft-aware artifact. Never use an arbitrary previous release or a pre-Microsoft binary.
5. Smoke the actual post-migration artifact with the controlled fixtures below. Keep audit, consent, evidence, denial, and tombstone history intact.

The smoke checklist must demonstrate:

- Microsoft-only evidence is rejected while issuance is off;
- revoked provider consent/proof is rejected;
- provider-off or disabled Microsoft policy rejects Microsoft-only evidence while independently valid school-email evidence remains eligible;
- an inactive base institution invalidates eligibility, including otherwise independently valid school-email evidence;
- mixed proof with independently current school-email evidence remains eligible through the email proof;
- expired email proof is not a fallback;
- an authoritative denial remains binding;
- pending start/callback/finish paths cannot issue new Microsoft proof;
- old Microsoft-bound merchant assertions fail;
- newly issued email-bound assertions can succeed with valid email proof; and
- owner history, withdrawal, unlink, and cleanup remain available with issuance off.

Never drop audit/consent/evidence tables, clear authoritative denial, erase revoked-identity tombstones, or substitute process health for the evidence checks above. If the smoke fails, keep issuance off, preserve the evidence, and use an approved forward repair.

## 8. Required release record

Before any enablement, attach the following to the execution report:

- exact clean commit SHA, immutable artifact digest, ordered applied migrations/schema record, build command, and source-absent runtime result;
- dirty-diff status and every command's exit code, including skips and failures;
- independent review result and unresolved findings;
- IT authorization, tenant ID provenance, policy/notice version, scopes, approval expiry, lifecycle/recheck agreement, authorized account expiry, and redacted staging observations;
- deployment authority, target-specific backup/restore and proxy/log evidence, worker inventory, drain/cancel record, and rollback smoke results; and
- a precise statement of what is local evidence, staging evidence, deployment evidence, and actual-pilot evidence.

Absent evidence remains absent. Do not replace it with screenshots, inferred email domains, a green local test, or a general operational-health signal.
