#!/usr/bin/env python3
"""Preserve legacy uploads before Compose replaces the backend. Run on the VPS."""
import contextlib
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import tarfile
import tempfile
import uuid


def docker(*args, **kwargs):
    return subprocess.run(['docker', *args], check=True, **kwargs)


def manifest(archive):
    result = {}
    with tarfile.open(archive, 'r:*') as stream:
        for member in stream:
            path = PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts or not (member.isfile() or member.isdir()):
                raise RuntimeError('Unsafe upload archive entry; original container retained')
            name = str(path)
            if member.isdir() and name != '.':
                result[name] = ('directory',)
            if member.isfile():
                if name in result:
                    raise RuntimeError('Duplicate archive entry')
                with stream.extractfile(member) as source:
                    digest = hashlib.sha256()
                    for chunk in iter(lambda: source.read(1024 * 1024), b''):
                        digest.update(chunk)
                    result[name] = (member.size, digest.hexdigest())
    return result


def capture(container, path, archive):
    with open(archive, 'wb') as output:
        docker('cp', f'{container}:{path}/.', '-', stdout=output)
        output.flush()
        os.fsync(output.fileno())
    return manifest(archive)


def deploy():
    container = os.environ.get('AWOOF_BACKEND_CONTAINER', 'awoof-backend')
    volume = os.environ.get('AWOOF_UPLOADS_VOLUME', 'awoof_backend_uploads')
    docker('info', stdout=subprocess.DEVNULL)
    inspected = subprocess.run(['docker', 'inspect', container], capture_output=True, text=True)
    if inspected.returncode:
        docker('compose', '-f', 'docker-compose.hostinger.yml', 'up', '-d', '--build')
        return
    state = json.loads(inspected.stdout)[0]
    if any(m['Destination'] == '/usr/src/app/uploads' and m['Type'] == 'volume' and m.get('Name') == volume for m in state['Mounts']):
        docker('compose', '-f', 'docker-compose.hostinger.yml', 'up', '-d', '--build')
        return
    # Build before stopping writes; archive the stopped container, including bind mounts.
    docker('compose', '-f', 'docker-compose.hostinger.yml', 'build')
    backup_dir = Path('backups/uploads')
    backup_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(backup_dir, 0o700)
    helper = 'awoof-upload-migration-' + uuid.uuid4().hex
    was_running = state['State']['Running']
    helper_created = False
    try:
        if was_running:
            docker('stop', container)
        descriptor, backup = tempfile.mkstemp(prefix='uploads-', suffix='.tar', dir=backup_dir)
        os.close(descriptor)  # mkstemp creates the retained backup with mode 0600.
        expected = capture(container, '/usr/src/app/uploads', backup)
        docker('volume', 'create', volume, stdout=subprocess.DEVNULL)
        docker('create', '--name', helper, '--network', 'none', '--user', '0',
               '--mount', f'type=volume,source={volume},target=/uploads,volume-nocopy',
               '--entrypoint', 'sh', state['Image'], '-c', 'sleep 3600', stdout=subprocess.DEVNULL)
        helper_created = True
        docker('start', helper, stdout=subprocess.DEVNULL)
        with tempfile.TemporaryDirectory() as temporary:
            check = Path(temporary) / 'verify.tar'
            existing = capture(helper, '/uploads', check)
            if existing and existing != expected:
                raise RuntimeError('Destination uploads differ; refusing to overwrite. Backup and original retained.')
            if not existing:
                with open(backup, 'rb') as source:
                    docker('cp', '-', f'{helper}:/uploads', stdin=source)
            docker('exec', helper, 'chown', '-R', '1001:1001', '/uploads')
            if capture(helper, '/uploads', check) != expected:
                raise RuntimeError('Upload checksum verification failed; original retained')
        # Keep the old backend stopped so no writes fall outside the verified copy.
        docker('compose', '-f', 'docker-compose.hostinger.yml', 'up', '-d', '--no-build')
        print('Uploads preserved and verified; restricted backup retained.')
    except BaseException:
        if was_running:
            # If Compose replaced the container, its volume still holds the verified files.
            subprocess.run(['docker', 'start', container], check=False)
        raise
    finally:
        if helper_created:
            with contextlib.suppress(subprocess.CalledProcessError):
                docker('rm', '-f', helper, stdout=subprocess.DEVNULL)


if __name__ == '__main__':
    # Also serializes direct operator runs with workflow runs on this host.
    import fcntl
    with open('.upload-deploy.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        deploy()
