#!/bin/bash
set -e

# --- Configuration & Flags ---
if [ -f .env ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    # Skip comments and empty lines
    [[ "$line" =~ ^#.*$ ]] || [ -z "$line" ] && continue
    # Export securely with proper string handling
    export "$line"
  done < .env
fi

# Defaults
REMOTE_HOST="${REMOTE_HOST:-pi}"
IMAGE_NAME="${IMAGE_NAME:-stalker-m3u-server}"
USE_SUDO=""

# --- Argument Parsing ---
for arg in "$@"; do
  case $arg in
    --sudo)
      USE_SUDO="sudo"
      shift
      ;;
  esac
done

echo "🚚 Pulling database from container '$IMAGE_NAME' on '$REMOTE_HOST'..."

# Copy remote database out of the Docker container to /tmp
ssh "$REMOTE_HOST" "${USE_SUDO} docker cp ${IMAGE_NAME}:/app/database.sqlite /tmp/remote_database.sqlite"

# Download remote database locally
echo "📥 Downloading remote database..."
scp "$REMOTE_HOST:/tmp/remote_database.sqlite" ./remote_database.sqlite

# Clean up remote temp file
ssh "$REMOTE_HOST" "${USE_SUDO} rm -f /tmp/remote_database.sqlite"

# Check if local database exists
if [ ! -f database.sqlite ]; then
  echo "📄 Local database.sqlite not found. Initializing with remote database."
  cp remote_database.sqlite database.sqlite
else
  echo "🔄 Merging remote database changes into local database.sqlite..."
  sqlite3 database.sqlite <<EOF
ATTACH 'remote_database.sqlite' AS remote;
INSERT OR REPLACE INTO channels SELECT * FROM remote.channels;
INSERT OR REPLACE INTO config_profiles SELECT * FROM remote.config_profiles;
INSERT OR REPLACE INTO content_cache SELECT * FROM remote.content_cache;
INSERT OR REPLACE INTO device_codes SELECT * FROM remote.device_codes;
INSERT OR REPLACE INTO epg_cache SELECT * FROM remote.epg_cache;
INSERT OR REPLACE INTO genres SELECT * FROM remote.genres;
INSERT OR REPLACE INTO system_config SELECT * FROM remote.system_config;
INSERT OR REPLACE INTO tokens SELECT * FROM remote.tokens;
INSERT OR REPLACE INTO users SELECT * FROM remote.users;
INSERT OR REPLACE INTO user_progress SELECT * FROM remote.user_progress;
DETACH remote;
EOF
fi

# Clean up local temp file
rm -f remote_database.sqlite

echo "✨ Merge complete!"
