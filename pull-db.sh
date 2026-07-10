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

LIVE_CONTAINER="stalker-m3u-server"
BETA_CONTAINER="stalker-m3u-server-beta"

echo "🚚 Pulling databases from remote host '$REMOTE_HOST'..."

# Create a local backup of the current local database before merging
if [ -f database.sqlite ]; then
  echo "💾 Backing up local database.sqlite to database.sqlite.bak..."
  cp database.sqlite database.sqlite.bak
fi

# 1. Pull Live DB
LIVE_PULLED=false
echo "📥 Attempting to pull live DB..."
if ssh "$REMOTE_HOST" "[ -f ~/stalker-data/${LIVE_CONTAINER}/database.sqlite ]" 2>/dev/null; then
  echo "  Found live DB on host path."
  scp "$REMOTE_HOST:~/stalker-data/${LIVE_CONTAINER}/database.sqlite" ./remote_live.sqlite 2>/dev/null && LIVE_PULLED=true
elif ssh "$REMOTE_HOST" "${USE_SUDO} docker ps -a -q -f name=^${LIVE_CONTAINER}$ | grep -q ." 2>/dev/null; then
  echo "  Found live DB inside container."
  if ssh "$REMOTE_HOST" "${USE_SUDO} docker cp ${LIVE_CONTAINER}:/app/database.sqlite /tmp/remote_live.sqlite" 2>/dev/null; then
    scp "$REMOTE_HOST:/tmp/remote_live.sqlite" ./remote_live.sqlite 2>/dev/null && LIVE_PULLED=true
    ssh "$REMOTE_HOST" "${USE_SUDO} rm -f /tmp/remote_live.sqlite"
  fi
fi

# 2. Pull Beta DB
BETA_PULLED=false
echo "📥 Attempting to pull beta DB..."
if ssh "$REMOTE_HOST" "[ -f ~/stalker-data/${BETA_CONTAINER}/database.sqlite ]" 2>/dev/null; then
  echo "  Found beta DB on host path."
  scp "$REMOTE_HOST:~/stalker-data/${BETA_CONTAINER}/database.sqlite" ./remote_beta.sqlite 2>/dev/null && BETA_PULLED=true
elif ssh "$REMOTE_HOST" "${USE_SUDO} docker ps -a -q -f name=^${BETA_CONTAINER}$ | grep -q ." 2>/dev/null; then
  echo "  Found beta DB inside container."
  if ssh "$REMOTE_HOST" "${USE_SUDO} docker cp ${BETA_CONTAINER}:/app/database.sqlite /tmp/remote_beta.sqlite" 2>/dev/null; then
    scp "$REMOTE_HOST:/tmp/remote_beta.sqlite" ./remote_beta.sqlite 2>/dev/null && BETA_PULLED=true
    ssh "$REMOTE_HOST" "${USE_SUDO} rm -f /tmp/remote_beta.sqlite"
  fi
fi

# 3. Merge Databases
if [ "$LIVE_PULLED" = "true" ]; then
  echo "🔄 Merging live DB changes..."
  npx ts-node -r tsconfig-paths/register src/utils/mergeDatabases.ts database.sqlite remote_live.sqlite
  rm -f remote_live.sqlite
else
  echo "⚠️ Live DB was not found on remote."
fi

if [ "$BETA_PULLED" = "true" ]; then
  echo "🔄 Merging beta DB changes..."
  npx ts-node -r tsconfig-paths/register src/utils/mergeDatabases.ts database.sqlite remote_beta.sqlite
  rm -f remote_beta.sqlite
else
  echo "⚠️ Beta DB was not found on remote."
fi

echo "✨ Sync and merge complete!"
