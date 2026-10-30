#!/usr/bin/env bash
# Sync code to the server and restart. Usage: deploy/deploy.sh [ssh-host]
set -euo pipefail
HOST="${1:-oracle}"
cd "$(dirname "$0")/.."
npm test
rsync -az --delete --exclude node_modules --exclude data --exclude .env --exclude .claude --exclude /node --exclude /test ./ "$HOST:/opt/agenttown/"
# Node 22 lives in /opt/agenttown/node so the host's system Node (used by other services) stays untouched.
ssh "$HOST" 'cd /opt/agenttown && PATH=/opt/agenttown/node/bin:$PATH npm ci --omit=dev --silent && sudo systemctl restart agenttown && sleep 1 && systemctl is-active agenttown'
