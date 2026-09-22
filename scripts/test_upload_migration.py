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
import json
import subprocess
from unittest.mock import patch
import uuid


class HelperImageTests(unittest.TestCase):
    def exercise(self, image_available=True):
        calls = []
        state = {'Image': 'sha256:missing-old-image', 'Mounts': [], 'State': {'Running': True}}

        def run(args, **kwargs):
            calls.append(args)
            if args[:2] == ['docker', 'inspect']:
                return subprocess.CompletedProcess(args, 0, json.dumps([state]))
            if 'config' in args:
                return subprocess.CompletedProcess(args, 0, json.dumps({'services': {'backend': {'image': 'awoof-backend'}}}))
            if args[1:3] == ['image', 'inspect']:
                if not image_available:
                    raise subprocess.CalledProcessError(1, args)
                return subprocess.CompletedProcess(args, 0, 'sha256:new-built-image\n')
            if args[1] == 'create' and 'sha256:missing-old-image' in args:
                raise subprocess.CalledProcessError(1, args, stderr='No such image')
            return subprocess.CompletedProcess(args, 0, '')

        original_cwd = os.getcwd()
        try:
            with tempfile.TemporaryDirectory() as directory:
                os.chdir(directory)
                with patch.object(migration.subprocess, 'run', side_effect=run), patch.object(migration, 'capture', return_value={}):
                    if image_available:
                        migration.deploy()
                    else:
                        with self.assertRaises(subprocess.CalledProcessError):
                            migration.deploy()
        finally:
            os.chdir(original_cwd)
        return calls

    def test_missing_old_image_does_not_prevent_replacement(self):
        calls = self.exercise()
        self.assertTrue(any('--no-build' in call for call in calls))
        create = next(call for call in calls if call[1] == 'create')
        self.assertIn('sha256:new-built-image', create)

    def test_missing_new_image_fails_before_stopping_backend(self):
        calls = self.exercise(False)
        self.assertFalse(any(call[1] == 'stop' for call in calls))


@unittest.skipUnless(os.environ.get('AWOOF_TEST_UPLOAD_DOCKER') == '1', 'disposable Docker fixture is CI-only')
class DockerMigrationTests(unittest.TestCase):
    def exercise(self, mismatch):
        name = 'awoof-test-' + uuid.uuid4().hex
        volume = name + '-uploads'
        actual_docker = migration.docker
        actual_run = subprocess.run
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

            def missing_legacy_image(args, **kwargs):
                result = actual_run(args, **kwargs)
                if args == ['docker', 'inspect', name] and result.returncode == 0:
                    state = json.loads(result.stdout)
                    # Keep the real container/files, but simulate its image having
                    # disappeared from the image store, as on the VPS.
                    state[0]['Image'] = 'sha256:' + '0' * 64
                    result.stdout = json.dumps(state)
                return result

            def command(*args, **kwargs):
                if args[0] != 'compose':
                    return actual_docker(*args, **kwargs)
                if 'build' in args:
                    return None
                if 'config' in args:
                    return subprocess.CompletedProcess(args, 0, json.dumps({'services': {'backend': {'image': 'alpine:3.21'}}}))
                self.assertEqual(subprocess.check_output(['docker', 'inspect', '--format', '{{.State.Running}}', name], text=True).strip(), 'false')
                actual_docker('rm', name, stdout=subprocess.DEVNULL)
                actual_docker('run', '-d', '--name', name, '-v', volume + ':/usr/src/app/uploads',
                              'alpine:3.21', 'sleep', '3600', stdout=subprocess.DEVNULL)
                replaced.append(True)

            with tempfile.TemporaryDirectory() as directory:
                os.chdir(directory)
                with patch.dict(os.environ, AWOOF_BACKEND_CONTAINER=name, AWOOF_UPLOADS_VOLUME=volume), patch.object(migration, 'docker', command), patch.object(migration.subprocess, 'run', missing_legacy_image):
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
