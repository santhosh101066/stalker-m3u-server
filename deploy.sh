#!/bin/bash
set -e

# --- Configuration ---
if [ -f .env ]; then
  # Using a cleaner way to export .env without xargs issues
  export $(grep -v '^#' .env | xargs)
fi

# Defaults
REMOTE_HOST="${REMOTE_HOST:-pi}"
REMOTE_DIR="${REMOTE_DIR:-~/downloads}"
IMAGE_NAME="${IMAGE_NAME:-stalker-m3u-server}"
TAR_NAME="$IMAGE_NAME.tar"

# --- Helper Functions ---
function build_and_push() {
  echo "📦 Building Docker image..."
  # Added --platform to fix that warning you saw
  docker build --platform linux/amd64 -t $IMAGE_NAME .

  echo "💾 Saving image to $TAR_NAME..."
  rm -f $TAR_NAME
  docker save $IMAGE_NAME > $TAR_NAME

  echo "🚚 Copying to $REMOTE_HOST..."
  scp $TAR_NAME $REMOTE_HOST:$REMOTE_DIR
  
  rm $TAR_NAME
}

function deploy_remote() {
  echo "🚀 Deploying on $REMOTE_HOST..."
  ssh $REMOTE_HOST << EOF
    cd $REMOTE_DIR
    echo "🛑 Stopping old container..."
    sudo docker stop $IMAGE_NAME || true
    sudo docker rm $IMAGE_NAME || true

    echo "📦 Loading new image..."
    sudo docker load < $TAR_NAME
    rm $TAR_NAME

    echo "🚀 Starting container..."
    sudo docker run -d --restart=always -p 3000:3000 --name $IMAGE_NAME $IMAGE_NAME
EOF
}

function restart_remote() {
  echo "🔄 Restarting $IMAGE_NAME on $REMOTE_HOST..."
  ssh $REMOTE_HOST "sudo docker restart $IMAGE_NAME"
}

function show_logs() {
  echo "📄 Tailing logs for $IMAGE_NAME on $REMOTE_HOST..."
  ssh $REMOTE_HOST "sudo docker logs --follow --tail 50 $IMAGE_NAME"
}

# --- Main Logic ---
COMMAND="$1"

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
    echo "Usage: ./deploy.sh [deploy|restart|logs]"
    echo "Running default: deploy"
    build_and_push
    deploy_remote
    echo "✅ Deployment complete!"
    ;;
esac