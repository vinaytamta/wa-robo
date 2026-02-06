#!/bin/bash
# Upload the Windows installer to the VPS so the group-iq.com download page serves it.
# Run from wa-robo after: npm run build:win
# Uses same VPS as admin-panel (group-iq.com).

set -e

VPS_USER="deploy"
VPS_HOST="72.60.204.23"
VPS_DOWNLOADS="/var/www/admin-panel/downloads"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/vps2_key}"
INSTALLER_NAME="GroupIQ Setup 1.0.0.exe"
REMOTE_NAME="GroupIQ-Setup-1.0.0.exe"
REMOTE_LATEST="GroupIQ-Setup-latest.exe"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_FILE="$REPO_ROOT/dist/$INSTALLER_NAME"

if [ ! -f "$DIST_FILE" ]; then
  echo "Error: Windows build not found at $DIST_FILE"
  echo "Run from wa-robo: npm run build:win"
  exit 1
fi

if [ ! -f "$SSH_KEY" ]; then
  echo "Error: SSH key not found at $SSH_KEY"
  exit 1
fi

echo "Uploading Windows build to VPS (group-iq.com)..."
echo "  Local:  $DIST_FILE"
echo "  Remote: $VPS_USER@$VPS_HOST:$VPS_DOWNLOADS/"

ssh -i "$SSH_KEY" "$VPS_USER@$VPS_HOST" "mkdir -p $VPS_DOWNLOADS"
scp -i "$SSH_KEY" "$DIST_FILE" "$VPS_USER@$VPS_HOST:$VPS_DOWNLOADS/$REMOTE_NAME"
ssh -i "$SSH_KEY" "$VPS_USER@$VPS_HOST" "cp -f $VPS_DOWNLOADS/$REMOTE_NAME $VPS_DOWNLOADS/$REMOTE_LATEST"

echo "Done. Download URLs (once nginx /downloads/ is configured):"
echo "  https://group-iq.com/downloads/$REMOTE_NAME"
echo "  https://group-iq.com/downloads/$REMOTE_LATEST"
