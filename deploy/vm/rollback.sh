#!/usr/bin/env bash
# Put production n8n back to a backup that deploy.sh took: stop n8n, replace the
# n8n_data volume with that backup's archive, start, health check. Everything in
# the volume goes back to that moment, including executions and any credential
# edited since. ssh-gate.sh runs it; rollback.yml calls the gate over SSH.
#
#   rollback.sh <backup-id | latest>
#   rollback.sh list
set -Eeuo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/vm/lib.sh
. "$HERE/lib.sh"

TARGET="${1:?usage: rollback.sh <backup-id | latest | list>}"

backups() { find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name '20*' -printf '%f\n' 2>/dev/null | sort -r; }

if [ "$TARGET" = list ]; then
  if [ -f "$BACKUP_ROOT/last-deployed" ]; then
    read -r sha id <"$BACKUP_ROOT/last-deployed"
    log "last deploy: ${sha:0:7} (its backup: $id)"
  fi
  log "backups, newest first:"
  backups
  exit 0
fi

take_lock

if [ "$TARGET" = latest ]; then
  TARGET="$(backups | head -n 1)"
  [ -n "$TARGET" ] || die "there are no backups"
fi
BK="$BACKUP_ROOT/$TARGET"
[ -s "$BK/n8n_data.tar.gz" ] || die "backup $TARGET not found"

docker inspect "$CONTAINER" >/dev/null 2>&1 || die "container $CONTAINER not found"
log "rolling back to backup $TARGET"
compose stop "$SERVICE" >/dev/null 2>&1
restore_volume "$BK"
compose up -d "$SERVICE" >/dev/null 2>&1
wait_healthy || die "n8n did not answer $HEALTH_URL after the restore: check it on the VM now"
log "n8n is healthy on backup $TARGET, with $(published_ids | wc -l) published workflows"
