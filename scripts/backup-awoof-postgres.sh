#!/bin/sh
# Create and validate a recoverable PostgreSQL dump before a production deploy.
set -eu

backup_dir="${AWOOF_BACKUP_DIR:-./backups}"
container="${AWOOF_POSTGRES_CONTAINER:-awoof-postgres}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="${backup_dir}/awoof-${timestamp}.dump"
temporary="${target}.tmp"

mkdir -p "$backup_dir"
chmod 700 "$backup_dir"

cleanup() {
    rm -f "$temporary"
}
trap cleanup EXIT HUP INT TERM

docker inspect "$container" >/dev/null
docker exec "$container" sh -lc \
    'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-acl' \
    > "$temporary"

if [ ! -s "$temporary" ]; then
    echo "Database backup is empty; deployment must stop." >&2
    exit 1
fi

docker exec -i "$container" pg_restore --list < "$temporary" >/dev/null
chmod 600 "$temporary"
mv "$temporary" "$target"
trap - EXIT HUP INT TERM

checksum="$(sha256sum "$target" | awk '{print $1}')"
echo "Verified database backup: $target"
echo "SHA-256: $checksum"
