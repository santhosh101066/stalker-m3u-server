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
REMOTE_DIR="/tmp/docker-deploy"
IMAGE_NAME="${IMAGE_NAME:-stalker-m3u-server}"
USE_SUDO=""
PLATFORM_FLAG="" # Default architecture
IS_BETA=false
PORT="3000"

# --- Argument Parsing ---
for arg in "$@"; do
  case $arg in
    --beta)
      IS_BETA=true
      ;;
    --sudo)
      USE_SUDO="sudo"
      ;;
    --arch=*)
      ARCH="${arg#*=}"
      PLATFORM_FLAG="--platform $ARCH"
      ;;
    deploy|restart|logs)
      COMMAND="$arg"
      ;;
  esac
done

if [ "$IS_BETA" = true ]; then
  IMAGE_NAME="stalker-m3u-server-beta"
  PORT="3001"
  echo "⚠️ Running in BETA mode (Port: $PORT, Container: $IMAGE_NAME)"
fi
TAR_NAME="$IMAGE_NAME.tar"

COMMAND="${COMMAND:-deploy}"

# --- Helper Functions ---
function build_and_push() {
  # 1. Pull remote DB changes first to avoid data loss
  echo "🔄 Syncing database from remote container before build..."
  local DB_CONTAINER_NAME="$IMAGE_NAME"

  # Check if remote container exists/is running
  if ssh "$REMOTE_HOST" "${USE_SUDO} docker ps -a -q -f name=^${DB_CONTAINER_NAME}$ | grep -q ." 2>/dev/null; then
    echo "📦 Remote container '$DB_CONTAINER_NAME' detected. Pulling remote database..."
    if ssh "$REMOTE_HOST" "${USE_SUDO} docker cp ${DB_CONTAINER_NAME}:/app/database.sqlite /tmp/remote_database.sqlite" 2>/dev/null; then
      echo "📥 Downloading remote database..."
      if scp "$REMOTE_HOST:/tmp/remote_database.sqlite" ./remote_database.sqlite 2>/dev/null; then
        ssh "$REMOTE_HOST" "${USE_SUDO} rm -f /tmp/remote_database.sqlite"

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
        rm -f remote_database.sqlite
        echo "✨ Remote database merge complete!"
      else
        echo "⚠️ Failed to download remote database file. Proceeding with local DB."
      fi
    else
      echo "⚠️ Failed to copy database from remote container. Proceeding with local DB."
    fi
  else
    echo "ℹ️ Remote container '$DB_CONTAINER_NAME' is not running/found. Skipping DB sync."
  fi

  # Inga thaan namba check panrom
  if [ -n "$PLATFORM_FLAG" ]; then
    echo "📦 Building Docker image with $PLATFORM_FLAG..."
  else
    echo "📦 Building Docker image (Default Architecture)..."
  fi

  docker build $PLATFORM_FLAG -t "$IMAGE_NAME" .

  echo "💾 Saving image to $TAR_NAME..."
  rm -f "$TAR_NAME"
  docker save "$IMAGE_NAME" > "$TAR_NAME"

  echo "🚚 Copying to $REMOTE_HOST..."
  ssh "$REMOTE_HOST" "mkdir -p $REMOTE_DIR"
  scp "$TAR_NAME" "$REMOTE_HOST:$REMOTE_DIR"
  
  rm "$TAR_NAME"
}

function deploy_remote() {
  echo "🚀 Deploying on $REMOTE_HOST (Sudo Mode: ${USE_SUDO:-Off})..."
  
  ssh "$REMOTE_HOST" << EOF
    cd "$REMOTE_DIR" || exit
    
    echo "🛑 Stopping old container..."
    $USE_SUDO docker stop "$IMAGE_NAME" || true
    $USE_SUDO docker rm "$IMAGE_NAME" || true

    echo "📦 Loading new image..."
    $USE_SUDO docker load < "$TAR_NAME"
    rm "$TAR_NAME"

    echo "🚀 Starting container..."
    $USE_SUDO docker run -d --restart=always -p $PORT:3000 --name "$IMAGE_NAME" "$IMAGE_NAME"
    
    echo "🧹 Cleaning up old images..."
    $USE_SUDO docker image prune -f
EOF
}

function restart_remote() {
  echo "🔄 Restarting $IMAGE_NAME on $REMOTE_HOST..."
  ssh "$REMOTE_HOST" "$USE_SUDO docker restart $IMAGE_NAME"
}

function show_logs() {
  echo "📄 Tailing logs for $IMAGE_NAME on $REMOTE_HOST..."
  ssh "$REMOTE_HOST" "$USE_SUDO docker logs --follow --tail 50 $IMAGE_NAME"
}

# --- Main Logic ---
case "$COMMAND" in
  "deploy")
    build_and_push
    deploy_remote
    echo "✅ Deployment complete!"
    ;;
  "restart")
    restart_remote
    echo "✅ Restart complete!"
    ;;
  "logs")
    show_logs
    ;;
  *)
    echo "Usage: ./deploy.sh [deploy|restart|logs] [--sudo] [--arch=linux/arm64]"
    echo "Running default: deploy"
    build_and_push
    deploy_remote
    echo "✅ Deployment complete!"
    ;;
esac