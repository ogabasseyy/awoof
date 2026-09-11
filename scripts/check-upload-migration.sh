#!/bin/sh
# Read-only deployment preflight. Never replace a container whose files would be hidden.
set -eu
container="${AWOOF_BACKEND_CONTAINER:-awoof-backend}"
if ! docker inspect "$container" >/dev/null 2>&1; then
    # Distinguish an absent container from an unavailable Docker service.
    docker info >/dev/null
    exit 0
fi
mount_type="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/usr/src/app/uploads"}}{{.Type}}{{end}}{{end}}' "$container")"
mount_name="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/usr/src/app/uploads"}}{{.Name}}{{end}}{{end}}' "$container")"
expected_volume="${AWOOF_UPLOADS_VOLUME:-awoof_backend_uploads}"
if [ "$mount_type" != volume ] || [ "$mount_name" != "$expected_volume" ]; then
    echo 'Deployment stopped: preserve and migrate existing backend uploads into the Compose named volume first. See docs/DEPLOYMENT-PREREQUISITES.md.' >&2
    exit 1
fi
