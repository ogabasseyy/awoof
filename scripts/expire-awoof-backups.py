#!/usr/bin/env python3
"""
Awoof PostgreSQL Backup Expiry Tool

Performs time-based expiry of database backup dumps based on trustworthy
manifest metadata, ensuring compliance with privacy retention constraints
(NDPA 2023) without risking catastrophic data loss.

Safeguards:
1. Trustworthy creation timestamp: Uses ISO-8601 createdAt from the sidecar
   .manifest.json, never mutable filesystem mtime alone.
2. Symlink protection: Strictly ignores and rejects symlinks.
3. Strict path bounding: Operates exclusively within the configured backup
   directory on exact 'awoof-*.dump' files.
4. Conflict protection: If expiring all aged backups would leave 0 valid
   backups, the newest backup is preserved as a last-resort recovery copy,
   and a retention conflict is explicitly surfaced.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone, timedelta
import hashlib
import json
import os
from pathlib import Path
import re
import sys
from typing import Dict, List, Optional, Tuple, Any

DUMP_NAME_PATTERN = re.compile(r"^awoof-.*\.dump$")


class BackupItem:
    def __init__(self, dump_path: Path, manifest_path: Path, created_at: datetime, sha256: str, size_bytes: int):
        self.dump_path = dump_path
        self.manifest_path = manifest_path
        self.created_at = created_at
        self.sha256 = sha256
        self.size_bytes = size_bytes

    def age_days(self, now: datetime) -> float:
        return (now - self.created_at).total_seconds() / 86400.0


CLOCK_SKEW_TOLERANCE = timedelta(minutes=5)


def scan_backups(backup_dir: Path, verify_checksum: bool = False, now: Optional[datetime] = None) -> Tuple[List[BackupItem], List[str]]:
    """
    Scans the backup directory for valid, manifest-backed dumps.
    Returns (valid_items, warnings).
    """
    if now is None:
        now = datetime.now(timezone.utc)
    valid_items: List[BackupItem] = []
    warnings: List[str] = []

    if not backup_dir.is_dir():
        warnings.append(f"Backup directory does not exist: {backup_dir}")
        return valid_items, warnings

    for entry in sorted(backup_dir.iterdir()):
        if entry.is_symlink():
            warnings.append(f"Skipping symlink security hazard: {entry.name}")
            continue

        if not entry.is_file() or not DUMP_NAME_PATTERN.match(entry.name):
            continue

        manifest_path = entry.with_name(f"{entry.name}.manifest.json")
        if manifest_path.is_symlink():
            warnings.append(f"Skipping dump with symlinked manifest: {entry.name}")
            continue

        if not manifest_path.is_file():
            warnings.append(f"Missing manifest for backup dump: {entry.name}")
            continue

        try:
            with open(manifest_path, "r", encoding="utf-8") as f:
                data = json.load(f)

            if data.get("schemaVersion") != 1:
                warnings.append(f"Unsupported manifest schema in: {manifest_path.name}")
                continue

            created_at_str = data.get("createdAt")
            if not created_at_str or not isinstance(created_at_str, str):
                warnings.append(f"Missing or invalid createdAt in manifest: {manifest_path.name}")
                continue

            # Parse ISO 8601 UTC timestamp
            if created_at_str.endswith("Z"):
                created_at_str = created_at_str[:-1] + "+00:00"
            created_at = datetime.fromisoformat(created_at_str)
            if created_at.tzinfo is None:
                created_at = created_at.replace(tzinfo=timezone.utc)

            # A future-dated manifest is a clock or provenance error, not
            # a fresh backup: accepting it would give the misdated dump a
            # negative age, let apply mode expire genuine older backups
            # around it, and shield it for its future date plus retention.
            if created_at > now + CLOCK_SKEW_TOLERANCE:
                warnings.append(f"Future-dated manifest rejected: {manifest_path.name} createdAt {created_at.isoformat()} is later than host time {now.isoformat()}")
                continue

            sha256_hash = data.get("sha256", "")
            size_bytes = data.get("sizeBytes", entry.stat().st_size)

            if verify_checksum:
                if not sha256_hash or not isinstance(sha256_hash, str) or not sha256_hash.strip():
                    warnings.append(f"Missing or empty sha256 in manifest: {manifest_path.name}")
                    continue
                hasher = hashlib.sha256()
                with open(entry, "rb") as bf:
                    for chunk in iter(lambda: bf.read(65536), b""):
                        hasher.update(chunk)
                computed = hasher.hexdigest()
                if computed.lower() != sha256_hash.strip().lower():
                    warnings.append(f"Checksum mismatch for {entry.name}: expected {sha256_hash}, got {computed}")
                    continue

            valid_items.append(BackupItem(entry, manifest_path, created_at, sha256_hash, size_bytes))
        except Exception as e:
            warnings.append(f"Failed to parse manifest {manifest_path.name}: {e}")

    # Sort newest to oldest
    valid_items.sort(key=lambda item: item.created_at, reverse=True)
    return valid_items, warnings


def expire_backups(
    backup_dir: Path,
    retention_days: int,
    dry_run: bool = True,
    now: Optional[datetime] = None,
    verify_checksum: bool = False,
) -> Dict[str, Any]:
    """
    Evaluates backups against the retention cutoff.
    Enforces last-resort preservation if all backups are expired.
    """
    if now is None:
        now = datetime.now(timezone.utc)

    # In apply mode, always verify checksums to ensure corrupted dumps cannot displace valid backups
    effective_verify_checksum = verify_checksum or (not dry_run)
    cutoff = now - timedelta(days=retention_days)
    valid_items, warnings = scan_backups(backup_dir, verify_checksum=effective_verify_checksum, now=now)

    to_expire: List[BackupItem] = []
    to_keep: List[BackupItem] = []

    for item in valid_items:
        if item.created_at <= cutoff:
            to_expire.append(item)
        else:
            to_keep.append(item)

    retention_conflict = False
    preserved_last_resort: Optional[str] = None

    # Conflict protection: if all backups are expired, preserve the newest as last-resort recovery copy
    if len(valid_items) > 0 and len(to_keep) == 0:
        retention_conflict = True
        newest = to_expire.pop(0)  # Remove newest from deletion list
        to_keep.append(newest)
        preserved_last_resort = newest.dump_path.name

    deleted_dumps: List[str] = []
    if not dry_run:
        for item in to_expire:
            try:
                if item.dump_path.is_file():
                    item.dump_path.unlink()
                if item.manifest_path.is_file():
                    item.manifest_path.unlink()
                deleted_dumps.append(item.dump_path.name)
            except Exception as e:
                warnings.append(f"Failed to delete {item.dump_path.name}: {e}")
    else:
        deleted_dumps = [item.dump_path.name for item in to_expire]

    return {
        "backupDir": str(backup_dir),
        "retentionDays": retention_days,
        "cutoff": cutoff.isoformat(),
        "totalFound": len(valid_items),
        "keptCount": len(to_keep),
        "expiredCount": len(to_expire),
        "deletedDumps": deleted_dumps,
        "preservedLastResort": preserved_last_resort,
        "retentionConflict": retention_conflict,
        "dryRun": dry_run,
        "warnings": warnings,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Expire old PostgreSQL backups using trusted manifest timestamps.")
    parser.add_argument("--backup-dir", default=os.environ.get("AWOOF_BACKUP_DIR", "./backups"), help="Directory containing backups")
    parser.add_argument("--retention-days", type=int, default=int(os.environ.get("AWOOF_BACKUP_RETENTION_DAYS", "30")), help="Days of retention")
    parser.add_argument("--dry-run", dest="dry_run", action="store_true", help="Inspect without deleting files (default)")
    parser.add_argument("--apply", dest="dry_run", action="store_false", help="Perform actual deletion")
    parser.set_defaults(dry_run=True)
    parser.add_argument("--verify-checksum", action="store_true", default=False, help="Verify sha256 checksum before evaluating")

    args = parser.parse_args()

    if args.retention_days < 1:
        sys.stderr.write("Retention days must be a positive integer.\n")
        sys.exit(1)

    result = expire_backups(
        backup_dir=Path(args.backup_dir),
        retention_days=args.retention_days,
        dry_run=args.dry_run,
        verify_checksum=args.verify_checksum,
    )

    sys.stdout.write(json.dumps(result, indent=2) + "\n")

    if result["retentionConflict"]:
        sys.stderr.write(
            f"WARNING: Retention conflict detected! All backups were older than {args.retention_days} days. "
            f"Preserved '{result['preservedLastResort']}' as last-resort recovery copy.\n"
        )
        # Exit with status 2 to signal retention conflict to orchestrator/monitoring
        sys.exit(2)

    if result["warnings"]:
        sys.stderr.write(
            f"WARNING: {len(result['warnings'])} backup warnings require operator attention.\n"
        )
        sys.exit(3)


if __name__ == "__main__":
    main()
