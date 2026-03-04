#!/bin/sh
# Ensure uploads dir exists and is writable by nodejs (uid 1001) when using a mounted volume.
set -e
mkdir -p /usr/src/app/uploads/vendors
chown -R nodejs:nodejs /usr/src/app/uploads
exec su-exec nodejs "$@"
