#!/bin/sh
# Start as root only long enough to make the Railway-mounted volume (root-owned at mount time)
# writable by the non-root "konclave" user, then drop privileges and exec the helper as that user.
# The helper is blind by construction (never holds a share); running it non-root is defense in depth.
set -e

VAULTS_DIR="${KONCLAVE_VAULTS_DIR:-/data/vaults}"
mkdir -p "$VAULTS_DIR"
chown -R konclave:konclave /data

exec gosu konclave "$@"
