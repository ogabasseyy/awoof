# Deployment prerequisites

This integration is not release approval. The authenticated verification backend and signup UI are integrated; the replacement merchant/widget flow, own-verification UI and broader privacy work remain under review. Payment repairs are included for review; production activation is separate. Do not activate payments or claim that mailbox ownership proves enrollment.

GitHub requires `VPS_SSH_KEY` and independently verified `VPS_KNOWN_HOSTS`; optional `VPS_HOST`/`VPS_USER` must point to the intended account and checkout. Main must pass its required reviews/checks. Manual deployment also requires the latest successful main push CI. Deployment runs share one concurrency group and reject obsolete commits before filesystem sync and container replacement.

Configure `.env` on the VPS before deployment: HTTPS `NEXT_PUBLIC_API_URL`, `FRONTEND_URL` and `CORS_ORIGIN`; strong `DB_PASSWORD`, `REDIS_PASSWORD`, `JWT_SECRET`, `JWT_REFRESH_SECRET`; approved email delivery configuration and monitored `SUPPORT_EMAIL`. Changing `POSTGRES_PASSWORD`/`DB_PASSWORD` does not rotate an existing PostgreSQL role in a persistent volume. Plan and validate an actual database password rotation separately.

## Upload preservation

The deployment workflow runs `python3 scripts/deploy-with-uploads.py` on the VPS. It builds images before downtime, stops the legacy backend, retains a mode0600 archive under `backups/uploads`, copies into the explicitly named `awoof_backend_uploads` volume, restores uid/gid1001 ownership and compares file sizes and SHA256 checksums before Compose replaces the container. It rejects unsafe archives and differing nonempty destination volumes without overwriting them. The old backend stays stopped throughout copying and replacement; migration failure restarts it. Backups are retained on failure and success and excluded from rsync deletion. Keep these backups restricted and apply the normal retention policy after validating public and authorized-private access. No production migration was executed as part of this source change. Python3 and Docker access are prerequisites; direct operator runs use the same host lock as workflow runs.

## Database upgrades

Back up and verify restoration before upgrades. If preflight reports duplicate vendor payment references, reconcile those records without deleting paid-order history before applying026; it must not silently deduplicate financial records. Migration032 repairs legacy internal notes for databases that already recorded022, if retained source tables still exist. Dropped legacy data requires recovery from a backup. Large tables may require a maintenance window for validating constraints; no live table size or migration history was inspected here.

Migration031 revokes all but the newest existing active reporting key per vendor (created_at then id), establishes a unique active-key constraint, and starts hourly quota windows. Notify affected integrations through the normal rollout process. Lifetime usage is retained separately from each rolling one-hour window. Revoked keys require replacement; plaintext keys cannot be reconstructed.

## Payment migration and reconciliation

Migration033 establishes a global Paystack reference constraint across marketplace and vendor-reported payments. Historical duplicates or conflicting references stop the migration atomically and require financial reconciliation; never delete paid-order history to make it pass. Existing pending marketplace initializations are marked unknown because provider acceptance cannot be inferred from local state.

New initialization requests have a 15-second deadline. Retried pending checkouts reuse their saved authorization URL; unknown outcomes block a second initialization, even after pending-order expiry. Status verification or a signed webhook can complete the existing reference. If the provider never accepted an unknown request, an authorized operator must verify that reference with Paystack and record the reconciliation before clearing its initialization state to permit retry. Do not clear state solely because a request timed out. Successful payments that can no longer be fulfilled enter the refund queue. These repairs do not constitute production payment or deployment approval.

Vendor-site checkout and external voucher redemption are withheld from the public marketplace while merchant assertions are unavailable; existing vendors can switch back to Awoof payments. Definitive initialization rejections release their pending reservation for a corrected retry, while duplicate-reference and transport failures remain indeterminate. Bank resolution has a finite deadline. Signed Paystack webhooks bypass the separate unauthenticated abuse quota, so provider traffic never shares the ordinary user IP quota.

## Student-domain enablement

Existing `universities.domain` values describe institution websites; `email_domains` retains directory candidates. Migration030 intentionally does not approve them or manufacture an approving administrator. In Admin → Universities, saving a new or existing school opens Verification policy. Review the retained candidates against the institution's student-mailbox rules, enter exact domains, explicitly confirm approval and save. This writes the canonical `approved_student_email_domains`, records the current live administrator, increments policy version and invalidates superseded evidence through the existing transactional service. The same policy editor is available for every legacy school. Empty policy means signup is deliberately disabled until approval; this is shown explicitly in the editor. Do not backfill broad website domains as student authority.

Migration034 marks inventory consumption separately from payment status. New stock-debit paths set the marker atomically; historical vendor-site reports default to false, so refunds cannot inflate their stock. Historical completed marketplace payments retain their known stock-debit provenance. Any separate historical inventory adjustment needs documented reconciliation rather than inference from a vendor-reported payment.

CSV imports return the imported schools for explicit policy review and open that review workflow in the admin UI. Closing an editor does not mark it approved; schools without canonical domains retain an Approve domains action after reload. Institution removal deactivates verification through the audited policy service and retains users, consents and policy history. The policy editor can explicitly reactivate an institution. Voucher creation and publication are disabled while external redemption is suspended. Order updates lock and recheck the live vendor owner and active vendor before mutation. Vendor registration that commits before session issuance fails returns an explicit account-created recovery code and directs the browser to sign in rather than retry registration.


### Verification data and private uploads

Migration 035 releases registration reservations when the owning identity changes and repairs stale reservations. It adds challenge retention tracking. The backend runs a bounded cleanup at startup and every minute, removing payloads and digests from challenges expired for over 24 hours while retaining tombstone IDs referenced by evidence.

Vendor identity uploads now use `uploads/private-vendors` inside the existing persistent volume. Both new files and legacy document URLs require a live owner or admin bearer token. The uploads handler serves only explicitly referenced public media; it does not expose arbitrary files. The vendor settings page downloads documents through the authenticated API client. Any reverse proxy must forward `/uploads` to this handler, not serve the filesystem directly. Previously cached public identity documents must be purged from any external cache before rollout; application code cannot erase copies already downloaded.

Existing students can renew verification at `/student/verification` using the current processing notice, school email challenge, and enrollment check. Logout requires the captured refresh credential in its JSON body and conditionally revokes only its matching stored session. Bank-account resolution now uses POST `/api/vendors/payment/resolve-account` with a JSON body.


Widget domain saves now persist the corresponding canonical HTTPS origins (standard port 443) used by disclosure authorization. Existing configurations without origins expose “Save HTTPS disclosure origins” in the Integration page; the vendor must save them before disclosure use. Profile badges use effective eligibility, and renewal controls follow the backend method-availability response.
