#!/usr/bin/env python3
"""
Unit tests for scripts/expire-awoof-backups.py
"""

from datetime import datetime, timezone, timedelta
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
from typing import Optional
import unittest

spec = importlib.util.spec_from_file_location("expire_module", Path(__file__).with_name("expire-awoof-backups.py"))
expire_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(expire_module)


class BackupExpiryTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.backup_dir = Path(self.temp_dir.name)
        self.now = datetime(2026, 10, 18, 12, 0, 0, tzinfo=timezone.utc)

    def tearDown(self):
        self.temp_dir.cleanup()

    def create_backup(
        self,
        name: str,
        created_at: datetime,
        content: bytes = b"dump content",
        sha256: Optional[str] = None,
    ) -> Path:
        dump_path = self.backup_dir / name
        dump_path.write_bytes(content)
        manifest_path = self.backup_dir / f"{name}.manifest.json"
        digest = hashlib.sha256(content).hexdigest() if sha256 is None else sha256
        manifest_data = {
            "schemaVersion": 1,
            "backupFile": name,
            "sha256": digest,
            "sizeBytes": len(content),
            "format": "custom",
            "createdAt": created_at.isoformat(),
        }
        manifest_path.write_text(json.dumps(manifest_data), encoding="utf-8")
        return dump_path

    def test_expires_only_old_backups(self):
        # 10 days old (within 30-day window) -> keep
        recent = self.create_backup("awoof-20261008T120000Z.dump", self.now - timedelta(days=10))
        # 40 days old (past 30-day window) -> expire
        old = self.create_backup("awoof-20260908T120000Z.dump", self.now - timedelta(days=40))

        result = expire_module.expire_backups(self.backup_dir, retention_days=30, dry_run=False, now=self.now)
        self.assertEqual(result["totalFound"], 2)
        self.assertEqual(result["keptCount"], 1)
        self.assertEqual(result["expiredCount"], 1)
        self.assertEqual(result["retentionConflict"], False)

        self.assertTrue(recent.is_file())
        self.assertTrue(recent.with_name(f"{recent.name}.manifest.json").is_file())
        self.assertFalse(old.is_file())
        self.assertFalse(old.with_name(f"{old.name}.manifest.json").is_file())

    def test_conflict_protection_preserves_newest_as_last_resort(self):
        # Both backups are older than 30 days
        older = self.create_backup("awoof-20260801T120000Z.dump", self.now - timedelta(days=78))
        newest = self.create_backup("awoof-20260901T120000Z.dump", self.now - timedelta(days=47))

        result = expire_module.expire_backups(self.backup_dir, retention_days=30, dry_run=False, now=self.now)
        self.assertEqual(result["totalFound"], 2)
        self.assertEqual(result["keptCount"], 1)
        self.assertEqual(result["expiredCount"], 1)
        self.assertEqual(result["retentionConflict"], True)
        self.assertEqual(result["preservedLastResort"], newest.name)

        # Newest must be preserved!
        self.assertTrue(newest.is_file())
        self.assertTrue(newest.with_name(f"{newest.name}.manifest.json").is_file())
        # Older is deleted
        self.assertFalse(older.is_file())

    def test_dry_run_does_not_delete_files(self):
        old = self.create_backup("awoof-20260901T120000Z.dump", self.now - timedelta(days=47))
        recent = self.create_backup("awoof-20261010T120000Z.dump", self.now - timedelta(days=8))

        result = expire_module.expire_backups(self.backup_dir, retention_days=30, dry_run=True, now=self.now)
        self.assertEqual(result["expiredCount"], 1)
        self.assertEqual(result["dryRun"], True)

        # Both files remain untouched
        self.assertTrue(old.is_file())
        self.assertTrue(recent.is_file())

    def test_skips_symlinks(self):
        real_file = self.create_backup("awoof-real.dump", self.now - timedelta(days=40))
        symlink = self.backup_dir / "awoof-symlink.dump"
        os.symlink(real_file, symlink)

        valid_items, warnings = expire_module.scan_backups(self.backup_dir)
        names = [item.dump_path.name for item in valid_items]
        self.assertIn("awoof-real.dump", names)
        self.assertNotIn("awoof-symlink.dump", names)
        self.assertTrue(any("symlink" in w.lower() for w in warnings))

    def test_skips_dump_without_manifest(self):
        orphaned = self.backup_dir / "awoof-no-manifest.dump"
        orphaned.write_bytes(b"content")

        valid_items, warnings = expire_module.scan_backups(self.backup_dir)
        names = [item.dump_path.name for item in valid_items]
        self.assertNotIn(orphaned.name, names)
        self.assertTrue(any("missing manifest" in w.lower() for w in warnings))

    def test_verify_checksum_matching(self):
        self.create_backup("awoof-valid.dump", self.now - timedelta(days=5), content=b"unmodified backup data")
        valid_items, warnings = expire_module.scan_backups(self.backup_dir, verify_checksum=True)
        self.assertEqual(len(valid_items), 1)
        self.assertEqual(valid_items[0].dump_path.name, "awoof-valid.dump")
        self.assertEqual(len(warnings), 0)

    def test_verify_checksum_mismatched(self):
        self.create_backup(
            "awoof-corrupt.dump",
            self.now - timedelta(days=5),
            content=b"corrupt content",
            sha256="0000000000000000000000000000000000000000000000000000000000000000",
        )
        valid_items, warnings = expire_module.scan_backups(self.backup_dir, verify_checksum=True)
        self.assertEqual(len(valid_items), 0)
        self.assertTrue(any("checksum mismatch" in w.lower() for w in warnings))

    def test_verify_checksum_missing_or_empty(self):
        self.create_backup(
            "awoof-empty-hash.dump",
            self.now - timedelta(days=5),
            content=b"content",
            sha256="",
        )
        valid_items, warnings = expire_module.scan_backups(self.backup_dir, verify_checksum=True)
        self.assertEqual(len(valid_items), 0)
        self.assertTrue(any("missing or empty sha256" in w.lower() for w in warnings))

    def test_apply_mode_enforces_checksum_verification(self):
        older = self.create_backup("awoof-20260801T120000Z.dump", self.now - timedelta(days=78), content=b"older content")
        # Corrupt newer backup
        self.create_backup(
            "awoof-20261010T120000Z.dump",
            self.now - timedelta(days=8),
            content=b"newer corrupt content",
            sha256="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        )
        # Apply mode verifies checksums; corrupted newer backup is disqualified, triggering retention conflict
        result = expire_module.expire_backups(self.backup_dir, retention_days=30, dry_run=False, now=self.now)
        self.assertEqual(result["retentionConflict"], True)
        self.assertEqual(result["preservedLastResort"], older.name)
        self.assertTrue(older.is_file())

    def test_cli_defaults_to_dry_run(self):
        old = self.create_backup("awoof-20260908T120000Z.dump", self.now - timedelta(days=40))
        recent = self.create_backup("awoof-20261015T120000Z.dump", self.now - timedelta(days=3))
        orig_argv = sys.argv
        try:
            sys.argv = ["expire-awoof-backups.py", "--backup-dir", str(self.backup_dir), "--retention-days", "30"]
            expire_module.main()
        finally:
            sys.argv = orig_argv
        self.assertTrue(old.is_file())
        self.assertTrue(recent.is_file())

    def test_cli_apply_mode_deletes_expired(self):
        old = self.create_backup("awoof-20260908T120000Z.dump", self.now - timedelta(days=40))
        recent = self.create_backup("awoof-20261015T120000Z.dump", self.now - timedelta(days=3))
        orig_argv = sys.argv
        try:
            sys.argv = ["expire-awoof-backups.py", "--backup-dir", str(self.backup_dir), "--retention-days", "30", "--apply"]
            expire_module.main()
        finally:
            sys.argv = orig_argv
        self.assertFalse(old.is_file())
        self.assertTrue(recent.is_file())

    def test_cli_exits_with_status_3_on_warnings(self):
        orphaned = self.backup_dir / "awoof-no-manifest.dump"
        orphaned.write_bytes(b"content")
        orig_argv = sys.argv
        try:
            sys.argv = ["expire-awoof-backups.py", "--backup-dir", str(self.backup_dir)]
            with self.assertRaises(SystemExit) as cm:
                expire_module.main()
            self.assertEqual(cm.exception.code, 3)
        finally:
            sys.argv = orig_argv


if __name__ == "__main__":
    unittest.main()
