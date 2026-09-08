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
