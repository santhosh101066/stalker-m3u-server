#!/bin/bash
set -e

# --- Configuration & Flags ---
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi

# Defaults
REMOTE_HOST="${REMOTE_HOST:-pi}"
REMOTE_DIR="/tmp/docker-deploy"
IMAGE_NAME="${IMAGE_NAME:-stalker-m3u-server}"
TAR_NAME="$IMAGE_NAME.tar"
USE_SUDO=""
PLATFORM_FLAG="" # Default architecture

# --- Argument Parsing ---
for arg in "$@"; do
  case $arg in
    --sudo)
      USE_SUDO="sudo"
      shift
      ;;
    --arch=*)
      ARCH="${arg#*=}"
      shift
      ;;
  esac
done

COMMAND="$1"

# --- Helper Functions ---
function build_and_push() {
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
    $USE_SUDO docker run -d --restart=always -p 3000:3000 --name "$IMAGE_NAME" "$IMAGE_NAME"
    
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