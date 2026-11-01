#!/usr/bin/env bash
# Sync code to the server and restart. Usage: deploy/deploy.sh [ssh-host]
set -euo pipefail
HOST="${1:-oracle}"
cd "$(dirname "$0")/.."
npm test
# Sign the CLI exactly as https://agenttown.xyz serves it, with the OFFLINE release key (~/.agenttown-release/ed25519.key).
# Fails the deploy if the key is missing or the signature does not verify against the RELEASE_PUBKEY embedded in the
# CLI. Agents only auto-update to a signed CLI. Writes public/cli/agenttown.mjs.sig + release.json (git-ignored).
node scripts/sign-release.mjs --base-url https://agenttown.xyz
rsync -az --delete --exclude node_modules --exclude data --exclude .env --exclude .claude --exclude /node --exclude /test ./ "$HOST:/opt/agenttown/"
# Node 22 lives in /opt/agenttown/node so the host's system Node (used by other services) stays untouched.
ssh "$HOST" 'cd /opt/agenttown && PATH=/opt/agenttown/node/bin:$PATH npm ci --omit=dev --silent && sudo systemctl restart agenttown && sleep 1 && systemctl is-active agenttown'
