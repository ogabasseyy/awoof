# Deployment prerequisites

This integration is not release approval. The authenticated verification backend and signup UI are integrated; the replacement merchant/widget flow, own-verification UI and broader privacy work remain under review. Paystack remains deferred. Do not activate payments or claim that mailbox ownership proves enrollment.

GitHub requires `VPS_SSH_KEY` and independently verified `VPS_KNOWN_HOSTS`; optional `VPS_HOST`/`VPS_USER` must point to the intended account and checkout. Main must pass its required reviews/checks. Manual deployment also requires the latest successful main push CI. Deployment runs share one concurrency group and reject obsolete commits before filesystem sync and container replacement.

Configure `.env` on the VPS before deployment: HTTPS `NEXT_PUBLIC_API_URL`, `FRONTEND_URL` and `CORS_ORIGIN`; strong `DB_PASSWORD`, `REDIS_PASSWORD`, `JWT_SECRET`, `JWT_REFRESH_SECRET`; approved email delivery configuration and monitored `SUPPORT_EMAIL`. Changing `POSTGRES_PASSWORD`/`DB_PASSWORD` does not rotate an existing PostgreSQL role in a persistent volume. Plan and validate an actual database password rotation separately.

## Upload preservation

The deployment preflight refuses to replace an existing backend without a named upload volume. Before adoption, an authorized operator must stop upload writes, securely copy the complete `/usr/src/app/uploads` tree out of the old container, record file counts/checksums without publishing filenames, back up that copy with restricted access, and restore it into the exact Compose `backend_uploads` volume with uid/gid1001 ownership. Validate byte/count parity and public/authorized-private access before resuming writes. Bind mounts and differently named volumes require explicit inventory and migration too. Do not remove the old container or its backup before verification. The script's volume check is containment, not proof that a prior transfer was correct or that private document delivery is safe.

## Database upgrades

Back up and verify restoration before upgrades. If preflight reports duplicate vendor payment references, reconcile those records without deleting paid-order history before applying026; it must not silently deduplicate financial records. Migration032 repairs legacy internal notes for databases that already recorded022, if retained source tables still exist. Dropped legacy data requires recovery from a backup. Large tables may require a maintenance window for validating constraints; no live table size or migration history was inspected here.

Migration031 revokes all but the newest existing active reporting key per vendor (created_at then id), establishes a unique active-key constraint, and starts hourly quota windows. Notify affected integrations through the normal rollout process. Lifetime usage is retained separately from each rolling one-hour window. Revoked keys require replacement; plaintext keys cannot be reconstructed.
