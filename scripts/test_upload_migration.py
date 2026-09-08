import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('migration', Path(__file__).with_name('deploy-with-uploads.py'))
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


class ArchiveTests(unittest.TestCase):
    def archive(self, name, content=b'synthetic upload', kind=tarfile.REGTYPE):
        temporary = tempfile.NamedTemporaryFile(suffix='.tar')
        with tarfile.open(fileobj=temporary, mode='w') as archive:
            item = tarfile.TarInfo(name)
            item.type = kind
            item.size = len(content) if kind == tarfile.REGTYPE else 0
            archive.addfile(item, io.BytesIO(content))
        temporary.flush()
        return temporary

    def test_roundtrip_bytes_and_relative_paths(self):
        with self.archive('./private/document.pdf') as archive:
            result = migration.manifest(archive.name)
            self.assertEqual(result['private/document.pdf'][0], 16)
        with self.archive('private/document.pdf', b'changed') as archive:
            self.assertNotEqual(migration.manifest(archive.name), result)

    def test_rejects_unsafe_archive_entries(self):
        for name, kind in [('../escape', tarfile.REGTYPE), ('/absolute', tarfile.REGTYPE),
                           ('link', tarfile.SYMTYPE), ('hardlink', tarfile.LNKTYPE), ('device', tarfile.CHRTYPE)]:
            with self.subTest(name=name), self.archive(name, kind=kind) as archive:
                with self.assertRaises(RuntimeError):
                    migration.manifest(archive.name)

# CI supplies an already pulled Alpine image; this never touches the production daemon.
import os
import subprocess
from unittest.mock import patch
import uuid


@unittest.skipUnless(os.environ.get('AWOOF_TEST_UPLOAD_DOCKER') == '1', 'disposable Docker fixture is CI-only')
class DockerMigrationTests(unittest.TestCase):
    def exercise(self, mismatch):
        name = 'awoof-test-' + uuid.uuid4().hex
        volume = name + '-uploads'
        actual_docker = migration.docker
        original_cwd = os.getcwd()
        try:
            actual_docker('run', '-d', '--name', name, 'alpine:3.21', 'sh', '-c',
                          'mkdir -p /usr/src/app/uploads/private; printf synthetic > /usr/src/app/uploads/private/a; sleep 3600', stdout=subprocess.DEVNULL)
            # Wait for fixture creation, without depending on container scheduling.
            actual_docker('exec', name, 'sh', '-c', 'while [ ! -f /usr/src/app/uploads/private/a ]; do sleep 0.1; done')
            if mismatch:
                actual_docker('run', '--rm', '-v', volume + ':/uploads', 'alpine:3.21',
                              'sh', '-c', 'echo unrelated > /uploads/keep')
            replaced = []

            def command(*args, **kwargs):
                if args[0] != 'compose':
                    return actual_docker(*args, **kwargs)
                if 'build' in args:
                    return None
                self.assertEqual(subprocess.check_output(['docker', 'inspect', '--format', '{{.State.Running}}', name], text=True).strip(), 'false')
                actual_docker('rm', name, stdout=subprocess.DEVNULL)
                actual_docker('run', '-d', '--name', name, '-v', volume + ':/usr/src/app/uploads',
                              'alpine:3.21', 'sleep', '3600', stdout=subprocess.DEVNULL)
                replaced.append(True)

            with tempfile.TemporaryDirectory() as directory:
                os.chdir(directory)
                with patch.dict(os.environ, AWOOF_BACKEND_CONTAINER=name, AWOOF_UPLOADS_VOLUME=volume), patch.object(migration, 'docker', command):
                    if mismatch:
                        with self.assertRaisesRegex(RuntimeError, 'refusing to overwrite'):
                            migration.deploy()
                    else:
                        migration.deploy()
                backups = list(Path('backups/uploads').glob('*.tar'))
                self.assertEqual(len(backups), 1)
                self.assertEqual(backups[0].stat().st_mode & 0o777, 0o600)
                self.assertEqual(bool(replaced), not mismatch)
                self.assertEqual(subprocess.check_output(['docker', 'exec', name, 'cat', '/usr/src/app/uploads/private/a']), b'synthetic')
                self.assertEqual(subprocess.check_output(['docker', 'inspect', '--format', '{{.State.Running}}', name], text=True).strip(), 'true')
        finally:
            os.chdir(original_cwd)
            subprocess.run(['docker', 'rm', '-f', name], check=False, stdout=subprocess.DEVNULL)
            subprocess.run(['docker', 'volume', 'rm', volume], check=False, stdout=subprocess.DEVNULL)

    def test_preserves_layer_uploads_during_replacement(self):
        self.exercise(False)

    def test_keeps_original_and_backup_when_target_differs(self):
        self.exercise(True)


if __name__ == '__main__':
    unittest.main()
