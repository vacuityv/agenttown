#!/usr/bin/env bash
# Daily MySQL backup for Agent Town: local copies (14 days) + off-site copy via a write-only rrsync key.
# Installed as /usr/local/bin/agenttown-backup, run by /etc/cron.d/agenttown-backup (as root).
set -euo pipefail
DIR=/var/backups/agenttown
REMOTE=${AGENTTOWN_BACKUP_REMOTE:-root@43.167.233.75}
KEY=/root/.ssh/agenttown_backup
STAMP=$(date -u +%Y%m%d-%H%M%S)
FILE="$DIR/agenttown-$STAMP.sql.gz"

umask 077
mysqldump --single-transaction --quick --routines --no-tablespaces agenttown | gzip -9 > "$FILE.tmp"
mv "$FILE.tmp" "$FILE"
find "$DIR" -name 'agenttown-*.sql.gz' -mtime +14 -delete

# Off-site: the key only allows writing into the backup dir on the remote (rrsync -wo).
rsync -e "ssh -i $KEY -o BatchMode=yes -o StrictHostKeyChecking=accept-new" "$FILE" "$REMOTE:" \
  && echo "backup ok: $FILE (off-site copied)" \
  || { echo "backup ok: $FILE (OFF-SITE COPY FAILED)" >&2; exit 1; }
