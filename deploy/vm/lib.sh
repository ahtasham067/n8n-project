# Shared by deploy.sh and rollback.sh (sourced, not run). The defaults match the
# VM layout in deploy/vm/README.md; each one can be overridden in
# ~/.config/clinidesk-n8n-deploy.env.
#
# Output rule: print counts, ids and status only. deploy.yml runs these over
# SSH, and the Actions log of this public repo is public.

# shellcheck source=/dev/null
[ -f "$HOME/.config/clinidesk-n8n-deploy.env" ] && . "$HOME/.config/clinidesk-n8n-deploy.env"

APP_DIR="${N8N_APP_DIR:-$HOME/smilecare-n8n}"
COMPOSE_FILE="${N8N_COMPOSE_FILE:-$APP_DIR/docker-compose.prod.yml}"
# shellcheck disable=SC2034  # used by deploy.sh and rollback.sh
SERVICE="${N8N_SERVICE:-n8n}"
CONTAINER="${N8N_CONTAINER:-n8n}"
VOLUME="${N8N_VOLUME:-n8n_data}"
HEALTH_URL="${N8N_HEALTH_URL:-http://127.0.0.1:5678/healthz/readiness}"
BACKUP_ROOT="${N8N_BACKUP_DIR:-$HOME/backups/n8n-deploy}"
KEEP_BACKUPS="${N8N_KEEP_BACKUPS:-10}"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

compose() { docker compose -f "$COMPOSE_FILE" "$@"; }

# One deploy or rollback at a time.
take_lock() {
  mkdir -p "$BACKUP_ROOT"
  chmod 700 "$BACKUP_ROOT"
  exec 9>"$BACKUP_ROOT/.lock"
  flock -n 9 || die "another deploy or rollback is running"
}

container_running() {
  [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = true ]
}

# The image of the existing n8n container: the archive and restore helpers run
# in it, so the VM needs no other image.
n8n_image() { docker inspect -f '{{.Config.Image}}' "$CONTAINER"; }

# Published workflow ids, one per line, from the running instance.
published_ids() {
  docker exec "$CONTAINER" n8n list:workflow --active=true --onlyId 2>/dev/null \
    | grep -E '^[A-Za-z0-9_-]+$' || true
}

wait_healthy() {
  local code
  for _ in $(seq 1 60); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$HEALTH_URL" || true)"
    [ "$code" = 200 ] && return 0
    sleep 3
  done
  return 1
}

# $1 = backup dir. n8n must be stopped.
archive_volume() {
  docker run --rm --user 0:0 --entrypoint sh \
    -v "$VOLUME:/data:ro" -v "$1:/backup" "$(n8n_image)" \
    -c "tar -czf /backup/n8n_data.tar.gz -C /data . && chown $(id -u):$(id -g) /backup/n8n_data.tar.gz"
  chmod 600 "$1/n8n_data.tar.gz"
  docker run --rm --user 0:0 --entrypoint sh -v "$1:/backup:ro" "$(n8n_image)" \
    -c 'tar -tzf /backup/n8n_data.tar.gz >/dev/null'
}

# $1 = backup dir. Replaces the volume's contents with its archive. n8n must be stopped.
restore_volume() {
  [ -s "$1/n8n_data.tar.gz" ] || die "no volume archive in $1"
  docker run --rm --user 0:0 --entrypoint sh \
    -v "$VOLUME:/data" -v "$1:/backup:ro" "$(n8n_image)" \
    -c 'tar -tzf /backup/n8n_data.tar.gz >/dev/null &&
        find /data -mindepth 1 -maxdepth 1 -exec rm -rf {} + &&
        tar -xzf /backup/n8n_data.tar.gz -C /data'
}

# Keep the newest $KEEP_BACKUPS backups.
prune_backups() {
  local old
  old="$(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name '20*' | sort -r | tail -n +"$((KEEP_BACKUPS + 1))")"
  [ -z "$old" ] && return 0
  while read -r dir; do rm -rf -- "$dir"; done <<<"$old"
  log "pruned $(wc -l <<<"$old") old backup(s)"
}
