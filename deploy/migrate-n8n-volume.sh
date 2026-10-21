#!/usr/bin/env bash
# Migrate the live n8n_data Docker volume from this laptop to an Oracle ARM VM.
# Run from the n8n-project root on the laptop (or pass --restore-only on the VM).
#
# Critical: the live volume name must be "n8n_data", NOT "n8n-project_n8n_data".
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
ARCHIVE_NAME="${ARCHIVE_NAME:-n8n_data-migrate.tar.gz}"
VOLUME_NAME="${VOLUME_NAME:-n8n_data}"
VM_HOST="${VM_HOST:-}"          # e.g. ubuntu@130.61.x.x
SSH_KEY="${SSH_KEY:-}"          # optional: -i path

die() { echo "ERROR: $*" >&2; exit 1; }
info() { echo "$*"; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing command: $1"
}

confirm_live_volume() {
  require_cmd docker
  if ! docker ps -a --format '{{.Names}}' | grep -qx n8n; then
    info "WARN: container 'n8n' not found — will still archive volume '${VOLUME_NAME}' if it exists."
    docker volume inspect "$VOLUME_NAME" >/dev/null 2>&1 \
      || die "Volume '${VOLUME_NAME}' not found. List volumes: docker volume ls | grep n8n"
    return 0
  fi

  local mounted
  mounted="$(docker inspect n8n --format '{{range .Mounts}}{{if eq .Destination "/home/node/.n8n"}}{{.Name}}{{end}}{{end}}')"
  [[ -n "$mounted" ]] || die "Could not read volume mount for /home/node/.n8n on container n8n."
  if [[ "$mounted" != "$VOLUME_NAME" ]]; then
    die "Live container mounts '${mounted}', but this script targets '${VOLUME_NAME}'.
Refusing to copy the wrong volume (orphan 'n8n-project_n8n_data' is a common trap).
Re-run with VOLUME_NAME=${mounted} only if you are sure."
  fi
  info "Confirmed live volume: ${mounted}"
}

export_volume() {
  mkdir -p "$BACKUP_DIR"
  confirm_live_volume

  if docker ps --format '{{.Names}}' | grep -qx n8n; then
    info "Stopping n8n for a consistent SQLite snapshot..."
    (cd "$ROOT" && docker compose stop) || docker stop n8n
  fi

  info "Creating ${BACKUP_DIR}/${ARCHIVE_NAME} from volume ${VOLUME_NAME}..."
  docker run --rm \
    -v "${VOLUME_NAME}:/data" \
    -v "${BACKUP_DIR}:/backup" \
    alpine \
    tar czf "/backup/${ARCHIVE_NAME}" -C /data .

  ls -lh "${BACKUP_DIR}/${ARCHIVE_NAME}"
  info "Export done. You can start local n8n again with: docker compose start  (or ./start-n8n-whatsapp.sh)"
}

scp_to_vm() {
  require_cmd scp
  [[ -n "$VM_HOST" ]] || die "Set VM_HOST=ubuntu@<public-ip> to upload."
  [[ -f "${BACKUP_DIR}/${ARCHIVE_NAME}" ]] || die "Missing ${BACKUP_DIR}/${ARCHIVE_NAME} — run export first."

  local scp_opts=()
  [[ -n "$SSH_KEY" ]] && scp_opts+=(-i "$SSH_KEY")

  info "Uploading to ${VM_HOST}:~/${ARCHIVE_NAME}"
  scp "${scp_opts[@]}" "${BACKUP_DIR}/${ARCHIVE_NAME}" "${VM_HOST}:~/${ARCHIVE_NAME}"
}

restore_on_this_host() {
  require_cmd docker
  local src="${1:-$HOME/${ARCHIVE_NAME}}"
  [[ -f "$src" ]] || die "Archive not found: $src"

  info "Creating volume ${VOLUME_NAME} (no-op if exists)..."
  docker volume create "$VOLUME_NAME" >/dev/null

  info "Restoring $src into volume ${VOLUME_NAME}..."
  docker run --rm \
    -v "${VOLUME_NAME}:/data" \
    -v "$(dirname "$src"):/backup" \
    alpine \
    tar xzf "/backup/$(basename "$src")" -C /data

  info "Restore complete. Start with:"
  info "  cd ~/smilecare-n8n && docker compose -f docker-compose.prod.yml up -d"
}

usage() {
  cat <<EOF
Usage:
  # On laptop (n8n-project root):
  ./deploy/migrate-n8n-volume.sh export
  VM_HOST=ubuntu@<ip> ./deploy/migrate-n8n-volume.sh upload
  # Or one shot:
  VM_HOST=ubuntu@<ip> ./deploy/migrate-n8n-volume.sh all

  # On the VM (after scp of the tarball to ~):
  ./deploy/migrate-n8n-volume.sh restore
  ./deploy/migrate-n8n-volume.sh restore /path/to/n8n_data-migrate.tar.gz

Env:
  VOLUME_NAME   default: n8n_data
  BACKUP_DIR    default: <n8n-project>/backups
  ARCHIVE_NAME  default: n8n_data-migrate.tar.gz
  VM_HOST       e.g. ubuntu@130.61.x.x
  SSH_KEY       optional private key path for scp
EOF
}

main() {
  local cmd="${1:-}"
  case "$cmd" in
    export) export_volume ;;
    upload) scp_to_vm ;;
    all)
      export_volume
      scp_to_vm
      info "On the VM run: ./deploy/migrate-n8n-volume.sh restore ~/${ARCHIVE_NAME}"
      ;;
    restore)
      restore_on_this_host "${2:-$HOME/${ARCHIVE_NAME}}"
      ;;
    -h|--help|help|"") usage ;;
    *) die "Unknown command: $cmd (try --help)" ;;
  esac
}

main "$@"
