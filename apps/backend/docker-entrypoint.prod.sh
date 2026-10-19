#!/bin/sh
# Ensure the uploads dir exists and data dirs are writable by nodejs (uid 1001) when using mounted volumes.
set -e
mkdir -p /usr/src/app/uploads/vendors
# Do NOT create /usr/src/app/backups here: recreating it in the container
# layer would mask a missing backend_backups volume, and the backend
# startup gate must see the ledger directory exactly as mounted.
if [ -d /usr/src/app/backups ]; then
  chown -R nodejs:nodejs /usr/src/app/backups
fi
chown -R nodejs:nodejs /usr/src/app/uploads
exec su-exec nodejs "$@"
