#!/bin/bash

# Exit immediately if a command exits with a non-zero status.
set -e

# --- Configuration ---
REMOTE_HOST="pi" # Or the IP address of your Raspberry Pi
REMOTE_DIR="~/downloads"
IMAGE_NAME="stalker-m3u-server"
TAR_NAME="$IMAGE_NAME.tar"

# --- 1. Build and Package Locally ---
echo "📦 Building and packaging the Docker image..."
docker build -t $IMAGE_NAME .
echo "💾 Saving image to $TAR_NAME..."
# Remove the old tar file if it exists
rm -f $TAR_NAME
docker save $IMAGE_NAME > $TAR_NAME

# --- 2. Copy to Remote Host ---
echo "🚚 Copying $TAR_NAME to $REMOTE_USER@$REMOTE_HOST..."
scp $TAR_NAME $REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR

# --- 3. Deploy on Remote Host ---
echo "🚀 Deploying on the remote host..."
ssh $REMOTE_HOST << EOF
  cd $REMOTE_DIR

  echo "🛑 Stopping and removing old container..."
  docker stop $IMAGE_NAME || true
  docker rm $IMAGE_NAME || true
  docker rmi $IMAGE_NAME || true

  echo "📦 Loading new Docker image..."
  docker load < $TAR_NAME

  echo "🚀 Starting new container..."
  docker run -d --restart=always -p 3000:3000 --name $IMAGE_NAME $IMAGE_NAME

  echo "✅ Deployment complete!"
EOF

# --- 4. Cleanup ---
echo "🧹 Cleaning up local tar file..."
rm $TAR_NAME

echo "✨ All done!"