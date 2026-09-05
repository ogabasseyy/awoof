# Release and widget delivery repair notes

Read-only source investigation by /root/terra_release_design, with controller rulings below. This is not a deployment or proof of VPS state. It supplies a future bounded implementation plan for audit A10/A17.

## Exact-release deployment

Files: .github/workflows/deploy.yml, .github/workflows/ci.yml, docker-compose.hostinger.yml, apps/backend/Dockerfile.prod, apps/web/Dockerfile.prod, apps/backend/src/index.ts, docs/HANDOVER.md. Add scripts/verify-deployment.sh and scripts/rollback-release.sh when the complete task is planned.

- Resolve a full40hex chosenSHA from successful main-branch workflow_run or explicit manual input. Manual deploy must query Actions with actions:read and require successful repository/main/push CI for that sameSHA; checkout and verify HEAD before any remote operation. Do not treat workflow dispatch github.sha as deployment proof. Consider whether a newer CI run for sameSHA is in progress/failed rather than accepting any old success; gate on latest relevant run.
- Serialize production deployment with cancel-in-progress:false. Use immutable releases/<SHA> staging and an explicit current pointer, previous verified release/image IDs retained. Avoid current in-place rsync --delete (especially legacyuploads). Initial VPS layout/project/volume cutover requires a separately authorized inventory; never silently select new empty volumes.
- SHA-tag backend/web images, bake nonsecret release metadata, backend readiness checks actual PostgreSQL and required Redis, web metadata/health present. Bounded verify script checks migrate exit0, healthy services, internal/backend and external/web exactSHA, and widget artifact. A healthy old deployment is not success.
- Rollback restores a previously verified application release and reruns proof. Never automatically restore database data or assume schema rollback compatibility; require explicit compatibility acknowledgement. Current migration sequence is additive but that is not permission to guess a production rollback.

## Widget artifact

- Web production Docker context must include repo root so a pinned-lockfile widget builder can copy Rollup output into the actual web image. No new widget.awoof.com infrastructure should be assumed.
- Controller ruling: use a release-SHA/content-hash-qualified artifact path, not a fixed semver URL rebuilt with changed bytes under immutable cache. For example `/widget/<releaseSHA>/awoof.js`, plus a no-cache release manifest containing version, SHA and content hash. Dashboard snippets derive actual web origin and current validated release manifest. SDK contract is being modernized by the verification flow task, so packaging must use its reviewed result rather than freeze old leaked-studentID callbacks.
- Publish or explicitly disable source maps without dangling references. Remove dashboard/docs unmanaged widget.awoof.com references and stale planned-feature claims. CI must inspect the actual production image/artifact, not only a standalone Rollup build.
- Browser validation from a synthetic separate origin should exercise allow/deny origins, script loading, iframe/popup flow and minimum callback. A real public-host smoke check remains separately unverified until deployment is authorized; don't confuse local simulation with live delivery.

## Recovery artifacts

Files: scripts/backup-awoof-postgres.sh, env.deployment.example, docs/HANDOVER.md and deploy.yml. Add synthetic test-backup-restore script in a separate owned task.

- Preserve existing entrypoint but create paired custom-format DB dump and persisted uploads archive with one manifest, releaseSHA, timestamps, hashes and mode-safe metadata. Uploads come from the actual mounted backend_uploads volume, not image filesystem. Ensure a consistent write-quiesced snapshot or fail clearly; always resume writes/clean up after any failure.
- Rotate whole backup sets together. Backup presence/nonempty/pg_restore --list is not successful restore. Synthetic test creates uniquely named fixture DB/volume/files, backs up, restores to a distinct disposable target and asserts SQL values and file hashes. Never normal-env DB fallback, production container/volume names or broad deletion. A native PostgreSQL variant can reuse the guarded test harness if Docker is unavailable, but must test actual dump/restore and uploads artifact behavior.
- Off-host target/configuration and transport verification require an explicit operator choice and secret setup; do not invent credentials, remote path or successful replication. Source can enforce a configured transfer+checksum contract, but no live off-host/production restore claim is possible in this task.

## Evidence boundary

Exact current VPS layout, ownership, Compose project/volume names, reverse proxy, migration parity, external readiness URLs and recovery store remain unverified. No source hardening task is a migration/deployment authorization. Paystack feature work remains deferred.
