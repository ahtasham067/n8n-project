#!/usr/bin/env bash
# The forced command of the GitHub Actions deploy key on the VM
# (deploy/vm/README.md). Whatever the client asks to run, only these get through:
#
#   deploy <full commit sha>    the commit must be on main
#   rollback <backup id|latest>
#   status
#
# Installed once as ~/bin/clinidesk-n8n-gate. Copy it again whenever this file
# changes; deploy.sh and rollback.sh are always taken from the repo checkout.
set -Eeuo pipefail
umask 077

REPO_URL="${N8N_REPO_URL:-https://github.com/ahtasham067/n8n-project.git}"
REPO_DIR="${N8N_REPO_DIR:-$HOME/clinidesk-n8n-repo}"

die() { echo "gate: $*" >&2; exit 2; }

read -r action arg extra <<<"${SSH_ORIGINAL_COMMAND:-}" || true
[ -z "${extra:-}" ] || die "unexpected arguments"

sync_main() {
  [ -d "$REPO_DIR/.git" ] || git clone --quiet "$REPO_URL" "$REPO_DIR"
  git -C "$REPO_DIR" fetch --quiet --prune origin main
}

case "${action:-}" in
  deploy)
    [[ "${arg:-}" =~ ^[0-9a-f]{40}$ ]] || die "deploy needs a full commit sha"
    sync_main
    git -C "$REPO_DIR" merge-base --is-ancestor "$arg" origin/main 2>/dev/null || die "${arg:0:7} is not on main"
    git -C "$REPO_DIR" checkout --quiet --force --detach "$arg"
    exec bash "$REPO_DIR/deploy/vm/deploy.sh" "$arg"
    ;;
  rollback)
    [[ "${arg:-}" =~ ^(latest|[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7})$ ]] || die "rollback needs a backup id or latest"
    sync_main
    git -C "$REPO_DIR" checkout --quiet --force --detach origin/main
    exec bash "$REPO_DIR/deploy/vm/rollback.sh" "$arg"
    ;;
  status)
    [ -z "${arg:-}" ] || die "status takes no arguments"
    sync_main
    git -C "$REPO_DIR" checkout --quiet --force --detach origin/main
    exec bash "$REPO_DIR/deploy/vm/rollback.sh" list
    ;;
  *)
    die "allowed: deploy <sha> | rollback <backup id|latest> | status"
    ;;
esac
