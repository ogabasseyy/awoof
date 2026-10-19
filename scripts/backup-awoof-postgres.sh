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

if [ "$max_files" -lt 1 ] || [ "$minimum_free_percent" -lt 1 ] || [ "$minimum_free_percent" -gt 100 ]; then
    echo "Backup count must be positive and minimum free percent must be between 1 and 100." >&2
    exit 1
fi

available_percent="$(df -Pk "$backup_dir" | awk 'NR == 2 { print int(($4 * 100) / $2) }')"
if [ "$available_percent" -lt "$minimum_free_percent" ]; then
    echo "Only ${available_percent}% disk space is free; at least ${minimum_free_percent}% is required." >&2
    exit 1
fi

temporary="$(mktemp "${backup_dir}/awoof-${timestamp}.XXXXXX.tmp")"
target="${temporary%.tmp}.dump"

manifest_temp=""
published=0
cleanup() {
    rm -f "$temporary"
    [ -z "$manifest_temp" ] || rm -f "$manifest_temp"
    # Keep the renamed dump under cleanup until its manifest is also
    # published: an unmanifested dump would otherwise survive as an
    # orphan that rotation counts but the expiry tool rejects.
    if [ "$published" != "1" ]; then
        rm -f "$target"
    fi
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

if command -v sha256sum >/dev/null 2>&1; then
    checksum="$(sha256sum "$target" | awk '{print $1}')"
else
    checksum="$(shasum -a 256 "$target" | awk '{print $1}')"
fi
size_bytes="$(wc -c < "$target" | tr -d ' ')"
created_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
target_basename="$(basename "$target")"
manifest_temp="${target}.manifest.tmp"
manifest_target="${target}.manifest.json"

cat <<EOF > "$manifest_temp"
{
  "schemaVersion": 1,
  "backupFile": "$target_basename",
  "sha256": "$checksum",
  "sizeBytes": $size_bytes,
  "format": "custom",
  "createdAt": "$created_at"
}
EOF
chmod 600 "$manifest_temp"
mv "$manifest_temp" "$manifest_target"
# Durably flush the dump, manifest, and directory entries before the
# pair counts as published and rotation may delete older copies.
if command -v python3 >/dev/null 2>&1; then
    python3 - "$target" "$manifest_target" "$backup_dir" <<'PYEOF'
import os, sys
for path in sys.argv[1:3]:
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
dfd = os.open(sys.argv[3], os.O_RDONLY)
try:
    os.fsync(dfd)
finally:
    os.close(dfd)
PYEOF
else
    sync
fi
published=1
trap - EXIT HUP INT TERM

echo "Verified database backup: $target"
echo "SHA-256: $checksum"
echo "Manifest: $manifest_target"

# Rotate only manifest-backed dump pairs. An unmanifested dump can
# survive an uncatchable KILL between the dump rename and manifest
# publication; counting it here would silently evict usable recovery
# copies while the expiry tool rejects the orphan. Orphans are left
# for operator inspection (and are reported by the expiry dry-run).
manifest_valid() {
    # A pair counts as a usable recovery copy only when its manifest
    # parses and its recorded checksum matches the dump; malformed or
    # mismatched pairs are excluded from rotation exactly like orphans.
    manifest="$1"
    dump="$2"
    [ -f "$manifest" ] || return 1
    grep -Eq '"schemaVersion"[[:space:]]*:[[:space:]]*1([^0-9]|$)' "$manifest" || return 1
    if command -v python3 >/dev/null 2>&1; then
        python3 - "$manifest" "$dump" <<'PYEOF' >/dev/null 2>&1 || return 1
import hashlib, json, sys
from datetime import datetime, timedelta, timezone
with open(sys.argv[1], encoding="utf-8") as fh:
    data = json.load(fh)
if data.get("schemaVersion") != 1:
    raise SystemExit(1)
created = data.get("createdAt")
if not isinstance(created, str) or not created:
    raise SystemExit(1)
parsed_created = datetime.fromisoformat(created[:-1] + "+00:00" if created.endswith("Z") else created)
if parsed_created.tzinfo is None:
    parsed_created = parsed_created.replace(tzinfo=timezone.utc)
if parsed_created > datetime.now(timezone.utc) + timedelta(minutes=5):
    raise SystemExit(1)
recorded = data.get("sha256")
if not isinstance(recorded, str) or not recorded:
    raise SystemExit(1)
digest = hashlib.sha256()
with open(sys.argv[2], "rb") as fh:
    for chunk in iter(lambda: fh.read(1024 * 1024), b""):
        digest.update(chunk)
if digest.hexdigest() != recorded:
    raise SystemExit(1)
PYEOF
        return 0
    fi
    # Without python3 there is no trustworthy way to parse the top-level
    # manifest fields in shell; reject the pair rather than weakly
    # matching nested values or impossible timestamps.
    return 1
}

manifest_backed_count() {
    count=0
    for dump in "$backup_dir"/awoof-*.dump; do
        [ -f "$dump" ] || continue
        if manifest_valid "${dump}.manifest.json" "$dump"; then
            count=$((count + 1))
        fi
    done
    echo "$count"
}

while [ "$(manifest_backed_count)" -gt "$max_files" ]; do
    oldest=""
    for dump in "$backup_dir"/awoof-*.dump; do
        [ -f "$dump" ] || continue
        if manifest_valid "${dump}.manifest.json" "$dump"; then
            oldest="$dump"
            break
        fi
    done
    [ -n "$oldest" ] || break
    rm -f "$oldest" "${oldest}.manifest.json"
    echo "Rotated old database backup: $oldest"
done
