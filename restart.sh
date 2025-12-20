#!/bin/bash
# Script to restart the stalker-m3u-server container on the remote host

REMOTE_HOST="pi"
IMAGE_NAME="stalker-m3u-server"

echo "🔄 Restarting $IMAGE_NAME on $REMOTE_HOST..."

ssh $REMOTE_HOST "docker restart $IMAGE_NAME"

if [ $? -eq 0 ]; then
  echo "✅ Restart successful!"
  ssh $REMOTE_HOST "docker logs --tail 20 $IMAGE_NAME"
else
  echo "❌ Restart failed!"
fi
