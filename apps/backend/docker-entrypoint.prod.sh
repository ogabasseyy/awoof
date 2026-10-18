#!/bin/sh
# Ensure uploads and backups dirs exist and are writable by nodejs (uid 1001) when using mounted volumes.
set -e
mkdir -p /usr/src/app/uploads/vendors /usr/src/app/backups
chown -R nodejs:nodejs /usr/src/app/uploads /usr/src/app/backups
exec su-exec nodejs "$@"
