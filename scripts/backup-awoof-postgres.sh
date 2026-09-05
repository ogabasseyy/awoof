#!/bin/sh
# Create and validate a recoverable PostgreSQL dump before a production deploy.
set -eu

backup_dir="${AWOOF_BACKUP_DIR:-./backups}"
container="${AWOOF_POSTGRES_CONTAINER:-awoof-postgres}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
max_files="${AWOOF_BACKUP_MAX_FILES:-7}"
minimum_free_percent="${AWOOF_BACKUP_MIN_FREE_PERCENT:-10}"

mkdir -p "$backup_dir"
chmod 700 "$backup_dir"

case "$max_files:$minimum_free_percent" in
    *[!0-9:]*|:*|*:) echo "Backup limits must be positive integers." >&2; exit 1 ;;
esac

available_percent="$(df -Pk "$backup_dir" | awk 'NR == 2 { print int(($4 * 100) / $2) }')"
if [ "$available_percent" -lt "$minimum_free_percent" ]; then
    echo "Only ${available_percent}% disk space is free; at least ${minimum_free_percent}% is required." >&2
    exit 1
fi

temporary="$(mktemp "${backup_dir}/awoof-${timestamp}.XXXXXX.tmp")"
target="${temporary%.tmp}.dump"

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

while [ "$(find "$backup_dir" -maxdepth 1 -type f -name 'awoof-*.dump' | wc -l | tr -d ' ')" -gt "$max_files" ]; do
    oldest="$(find "$backup_dir" -maxdepth 1 -type f -name 'awoof-*.dump' | sort | head -n 1)"
    [ -n "$oldest" ] || break
    rm -f "$oldest"
    echo "Rotated old database backup: $oldest"
done
