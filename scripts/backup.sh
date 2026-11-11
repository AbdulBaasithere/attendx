#!/usr/bin/env bash
# Usage: DATABASE_URL=postgres://... ./scripts/backup.sh   (cron: 0 2 * * * /opt/attendx/scripts/backup.sh)
set -euo pipefail
DIR=${BACKUP_DIR:-./backups}; mkdir -p "$DIR"; F="$DIR/attendx_$(date +%F_%H%M).dump"
pg_dump -Fc "${DATABASE_URL:?set DATABASE_URL}" > "$F"
[ -d server/uploads ] && tar czf "${F%.dump}_uploads.tgz" -C server uploads || true
find "$DIR" -type f -mtime +"${KEEP_DAYS:-14}" -delete
echo "backup written: $F  (restore: pg_restore -d attendx --clean $F)"
