#!/usr/bin/env bash
# ==============================================================================
# Awoof Disposable Backup & Restore Reconciliation Drill
# ==============================================================================
# Performs an end-to-end automated restore drill on an ephemeral local PostgreSQL
# instance, verifying:
# 1. Creation of synthetic profiles and verified backup with manifest.
# 2. Student profile erasure recorded in dual deletion ledger.
# 3. Legitimate profile recreation with distinct generation UUID.
# 4. Restoration of historical backup into quarantine.
# 5. Independent reconciliation from host deletion ledger before exposure.
# 6. Immediate purge of stale restored generations.
# 7. Preservation of legitimate recreated generations.
# 8. Fail-closed behavior on corrupted ledger or missing state.
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Ensure postgres binaries
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH}"

for bin in initdb pg_ctl createdb dropdb pg_dump pg_restore psql; do
    if ! command -v "$bin" >/dev/null 2>&1; then
        echo "ERROR: Required PostgreSQL binary '$bin' not found." >&2
        exit 1
    fi
done

DRILL_TMP="$(mktemp -d "${TMPDIR:-/tmp}/awoof-restore-drill.XXXXXX")"
DATA_DIR="${DRILL_TMP}/data"
BACKUP_DIR="${DRILL_TMP}/backups"
SOCKET_DIR="${DRILL_TMP}/socket"
mkdir -p "$BACKUP_DIR" "$SOCKET_DIR"
chmod 700 "$BACKUP_DIR"

cleanup() {
    echo "Cleaning up ephemeral drill resources..."
    if [ -f "${DATA_DIR}/postmaster.pid" ]; then
        pg_ctl -D "$DATA_DIR" stop -m immediate >/dev/null 2>&1 || true
    fi
    rm -rf "$DRILL_TMP"
}
trap cleanup EXIT INT TERM

# Find available loopback port
PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')

echo "=== Step 1: Initializing ephemeral PostgreSQL on 127.0.0.1:${PORT} ==="
initdb -D "$DATA_DIR" -U awoof_test --auth-local=trust --auth-host=trust >/dev/null
pg_ctl -D "$DATA_DIR" -l "${DRILL_TMP}/postgres.log" -o "-h 127.0.0.1 -p ${PORT} -k ${SOCKET_DIR} -c listen_addresses=127.0.0.1" start -w -t 20 >/dev/null
createdb -h 127.0.0.1 -p "$PORT" -U awoof_test awoof_drill

DATABASE_URL="postgresql://awoof_test@127.0.0.1:${PORT}/awoof_drill"
export DATABASE_URL
export NODE_ENV="test"
export JWT_SECRET="test-jwt-secret-at-least-32-characters"
export JWT_REFRESH_SECRET="test-refresh-secret-at-least-32-characters"

echo "=== Step 2: Running migrations on ephemeral database ==="
(cd "${REPO_ROOT}/apps/backend" && npx tsx src/database/migrations/run.ts) >/dev/null

LEDGER_FILE="${BACKUP_DIR}/academic-profile-deletion-ledger.jsonl"
USER_A="00000000-0000-4000-8000-000000000001"
STUDENT_A="aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"
GEN_A="11111111-1111-4111-8111-111111111111"

USER_B="00000000-0000-4000-8000-000000000002"
STUDENT_B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
GEN_B1="22222222-2222-4222-8222-222222222221"
GEN_B2="22222222-2222-4222-8222-222222222222"

echo "=== Step 3: Seeding synthetic profiles (Student A Gen 1, Student B Gen 1) ==="
psql -h 127.0.0.1 -p "$PORT" -U awoof_test -d awoof_drill -v ON_ERROR_STOP=1 <<EOF
INSERT INTO users (id, email, role) VALUES ('$USER_A', 'student.a@school.test', 'student'), ('$USER_B', 'student.b@school.test', 'student');
INSERT INTO students (id, user_id, name) VALUES ('$STUDENT_A', '$USER_A', 'Student A'), ('$STUDENT_B', '$USER_B', 'Student B');
INSERT INTO student_academic_profiles (user_id, student_id, observed_identity_version, generation_id, entry_year_state, entry_year) VALUES ('$USER_A', '$STUDENT_A', 1, '$GEN_A', 'supplied', 2022);
INSERT INTO student_academic_profiles (user_id, student_id, observed_identity_version, generation_id, entry_year_state, entry_year) VALUES ('$USER_B', '$STUDENT_B', 1, '$GEN_B1', 'supplied', 2023);
EOF

echo "=== Step 4: Taking baseline database dump and creating manifest ==="
DUMP_FILE="${BACKUP_DIR}/awoof-drill.dump"
pg_dump -h 127.0.0.1 -p "$PORT" -U awoof_test -d awoof_drill --format=custom --no-owner --no-acl > "$DUMP_FILE"

if command -v sha256sum >/dev/null 2>&1; then
    CHECKSUM="$(sha256sum "$DUMP_FILE" | awk '{print $1}')"
else
    CHECKSUM="$(shasum -a 256 "$DUMP_FILE" | awk '{print $1}')"
fi
cat <<EOF > "${DUMP_FILE}.manifest.json"
{
  "schemaVersion": 1,
  "backupFile": "awoof-drill.dump",
  "sha256": "$CHECKSUM",
  "sizeBytes": $(wc -c < "$DUMP_FILE" | tr -d ' '),
  "format": "custom",
  "createdAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF

echo "=== Step 5: Students A and B erase profiles after backup (exercising service dual ledger recording) ==="
# Student B's erasure leaves a GEN_B1 tombstone in both ledgers. After the
# restore, B recreates with GEN_B2, so reconciliation must actively compare
# the tombstoned B1 generation against the live B2 generation and preserve
# it — without that tombstone the preservation branch would never execute.
(cd "${REPO_ROOT}/apps/backend" && ACADEMIC_PROFILE_DELETION_LEDGER_FILE="$LEDGER_FILE" npx tsx --input-type=module -e "
import { eraseAcademicProfileForUser } from './src/services/academic-profile/academic-profile.service.js';
import { db, getPool } from './src/config/database.js';

async function main() {
    const resultA = await eraseAcademicProfileForUser(getPool(), '$USER_A');
    if (!resultA.erased) {
        throw new Error('Erasure failed for Student A');
    }
    const resultB = await eraseAcademicProfileForUser(getPool(), '$USER_B');
    if (!resultB.erased) {
        throw new Error('Erasure failed for Student B');
    }
    await db.close();
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
")

echo "=== Step 6: Restoring historical backup into quarantined database ==="
dropdb -h 127.0.0.1 -p "$PORT" -U awoof_test awoof_drill
createdb -h 127.0.0.1 -p "$PORT" -U awoof_test awoof_drill
pg_restore -h 127.0.0.1 -p "$PORT" -U awoof_test -d awoof_drill "$DUMP_FILE"

# Capture the original restored generation BEFORE recreating it: the
# preservation check below is only meaningful with trajectory evidence
# that the backup actually resurrected B1 and the profile was then
# recreated as B2, rather than accepting the final B2 row at face value.
RESTORED_B_GEN=$(psql -h 127.0.0.1 -p "$PORT" -U awoof_test -d awoof_drill -t -A -c "SELECT generation_id FROM student_academic_profiles WHERE user_id = '$USER_B'")
if [ "$RESTORED_B_GEN" != "$GEN_B1" ]; then
    echo "ERROR: Expected backup restore to resurrect Student B original generation $GEN_B1, got $RESTORED_B_GEN" >&2
    exit 1
fi
echo "Verified: Backup restore resurrected Student B original generation ${RESTORED_B_GEN}; now recreating it as ${GEN_B2}."

# Now Student B legitimately recreates their profile with a new Generation ID B2
psql -h 127.0.0.1 -p "$PORT" -U awoof_test -d awoof_drill -v ON_ERROR_STOP=1 <<EOF
UPDATE student_academic_profiles SET generation_id = '$GEN_B2', entry_year = 2024 WHERE user_id = '$USER_B';
EOF

# Verify stale state exists before reconciliation
STALE_COUNT=$(psql -h 127.0.0.1 -p "$PORT" -U awoof_test -d awoof_drill -t -A -c "SELECT COUNT(*) FROM student_academic_profiles WHERE user_id = '$USER_A'")
if [ "$STALE_COUNT" -ne 1 ]; then
    echo "ERROR: Expected stale profile for Student A to be present before reconciliation." >&2
    exit 1
fi
echo "Verified: Stale restored profile for Student A is present in quarantine prior to reconciliation."

echo "=== Step 7: Running restore reconciliation from host deletion ledger ==="
RECONCILE_OUTPUT=$(cd "${REPO_ROOT}/apps/backend" && npx tsx src/scripts/reconcile-restored-academic-profiles.ts --ledger-file "$LEDGER_FILE")
echo "$RECONCILE_OUTPUT"
case "$RECONCILE_OUTPUT" in
    *"recreatedPreserved=1"*) ;;
    *)
        echo "ERROR: Reconciliation did not report preserving the recreated generation (expected recreatedPreserved=1)." >&2
        exit 1
        ;;
esac
echo "Verified: Reconciliation compared the GEN_B1 tombstone against live GEN_B2 and preserved the recreated profile."

echo "=== Step 8: Verifying post-reconciliation state ==="
# 1. Student A's erased profile must be ABSENT
A_COUNT=$(psql -h 127.0.0.1 -p "$PORT" -U awoof_test -d awoof_drill -t -A -c "SELECT COUNT(*) FROM student_academic_profiles WHERE user_id = '$USER_A'")
if [ "$A_COUNT" -ne 0 ]; then
    echo "ERROR: Student A profile was not purged by reconciliation!" >&2
    exit 1
fi

# 2. Student B's legitimate recreated profile (Gen B2) must be PRESERVED
# (trajectory proven above: restore resurrected $GEN_B1, recreation set B2)
B_GEN=$(psql -h 127.0.0.1 -p "$PORT" -U awoof_test -d awoof_drill -t -A -c "SELECT generation_id FROM student_academic_profiles WHERE user_id = '$USER_B'")
if [ "$B_GEN" != "$GEN_B2" ]; then
    echo "ERROR: Student B profile generation mismatch: expected $GEN_B2, got $B_GEN" >&2
    exit 1
fi
B_YEAR=$(psql -h 127.0.0.1 -p "$PORT" -U awoof_test -d awoof_drill -t -A -c "SELECT entry_year FROM student_academic_profiles WHERE user_id = '$USER_B'")
if [ "$B_YEAR" != "2024" ]; then
    echo "ERROR: Student B preserved profile is not the recreated one: expected entry_year 2024, got $B_YEAR" >&2
    exit 1
fi

# 3. Database ledger must contain Student A tombstone restored from host ledger
LEDGER_COUNT=$(psql -h 127.0.0.1 -p "$PORT" -U awoof_test -d awoof_drill -t -A -c "SELECT COUNT(*) FROM academic_profile_deletion_ledger WHERE user_id = '$USER_A' AND generation_id = '$GEN_A'")
if [ "$LEDGER_COUNT" -ne 1 ]; then
    echo "ERROR: Database deletion ledger missing tombstone for Student A!" >&2
    exit 1
fi

# 4. Database ledger must also contain the Student B GEN_B1 tombstone that
# reconciliation compared against (and preserved) the live GEN_B2 profile
LEDGER_COUNT_B=$(psql -h 127.0.0.1 -p "$PORT" -U awoof_test -d awoof_drill -t -A -c "SELECT COUNT(*) FROM academic_profile_deletion_ledger WHERE user_id = '$USER_B' AND generation_id = '$GEN_B1'")
if [ "$LEDGER_COUNT_B" -ne 1 ]; then
    echo "ERROR: Database deletion ledger missing tombstone for Student B GEN_B1!" >&2
    exit 1
fi

echo "Post-reconciliation verification successful: Stale generation purged, recreated generation preserved, tombstone restored."

echo "=== Step 9: Verifying fail-closed behavior on corrupted ledger ==="
CORRUPT_LEDGER="${DRILL_TMP}/corrupt-ledger.jsonl"
echo '{"invalid_json": true' > "$CORRUPT_LEDGER"

if (cd "${REPO_ROOT}/apps/backend" && npx tsx src/scripts/reconcile-restored-academic-profiles.ts --ledger-file "$CORRUPT_LEDGER") 2>/dev/null; then
    echo "ERROR: Reconciliation should have failed closed on corrupt ledger!" >&2
    exit 1
fi
echo "Verified: Reconciliation fails closed on corrupt ledger input."

echo "=== DISPOSABLE_RESTORE_DRILL_PASSED ==="
