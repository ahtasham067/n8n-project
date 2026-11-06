#!/usr/bin/env bash
# Deploy the workflows of one main commit to production n8n. ssh-gate.sh runs it
# after checking that commit out; deploy.yml calls the gate over SSH.
#
#   1. Export every workflow and credential from the running n8n (credentials
#      stay encrypted), and stop if a workflow being deployed uses a credential
#      id production doesn't have. Nothing has changed at that point.
#   2. Stop n8n and archive the n8n_data volume.
#   3. Import the files in workflows.txt by their fixed ids (an existing
#      workflow is updated in place), then publish them and everything that was
#      published before.
#   4. Start n8n, wait for /healthz/readiness, and check every id is published.
#   5. If anything fails after step 2, put the archived volume back and start n8n.
#
# Credentials are never imported, decrypted or printed.
#
#   deploy.sh <commit-sha>
set -Eeuo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
# shellcheck source=deploy/vm/lib.sh
. "$HERE/lib.sh"

SHA="${1:?usage: deploy.sh <commit-sha>}"
[ "$(git -C "$REPO" rev-parse HEAD)" = "$SHA" ] || die "the checkout in $REPO is not at $SHA"

take_lock

IDS=()
FILES=()
while read -r id file; do
  IDS+=("$id")
  FILES+=("$REPO/$file")
  [ -f "$REPO/$file" ] || die "workflows.txt lists $file, which doesn't exist"
done < <(grep -vE '^[[:space:]]*(#|$)' "$HERE/workflows.txt")
[ "${#IDS[@]}" -gt 0 ] || die "workflows.txt lists no workflows"

container_running || die "n8n ($CONTAINER) is not running. Start it, then deploy."

BACKUP_ID="$(date -u +%Y%m%dT%H%M%SZ)-${SHA:0:7}"
BK="$BACKUP_ROOT/$BACKUP_ID"
mkdir -p "$BK"
log "deploying ${SHA:0:7}: ${#IDS[@]} workflows; backup $BACKUP_ID"

# 1. Export, and check credentials.
docker exec "$CONTAINER" sh -c '
  rm -rf /tmp/clinidesk-export && mkdir -p /tmp/clinidesk-export &&
  n8n export:workflow --all --output=/tmp/clinidesk-export/workflows.json &&
  n8n export:credentials --all --output=/tmp/clinidesk-export/credentials.json' >/dev/null
docker cp "$CONTAINER:/tmp/clinidesk-export/." "$BK/" >/dev/null
docker exec "$CONTAINER" rm -rf /tmp/clinidesk-export
published_ids >"$BK/published-before.txt"
chmod 600 "$BK"/*

counts="$(python3 -I - "$BK/workflows.json" "$BK/credentials.json" <<'PY'
import json, sys
print(len(json.load(open(sys.argv[1]))), len(json.load(open(sys.argv[2]))))
PY
)"
log "exported ${counts% *} workflows and ${counts#* } credentials (encrypted); $(wc -l <"$BK/published-before.txt") published"

missing="$(python3 -I - "$BK/credentials.json" "${FILES[@]}" <<'PY'
import json, sys
have = {c["id"] for c in json.load(open(sys.argv[1]))}
need = set()
for path in sys.argv[2:]:
    for node in json.load(open(path)).get("nodes", []):
        for ref in (node.get("credentials") or {}).values():
            if ref.get("id"):
                need.add(ref["id"])
print(" ".join(sorted(need - have)))
PY
)"
[ -z "$missing" ] || die "production n8n has no credential with id: $missing. Create it with that id first (deploy/vm/README.md → Credentials). Nothing was changed."

# 2. Stop and archive. From here on, a failure starts n8n again, and once the
# volume has been written to, it is restored from the archive first.
STATE=running
on_failure() {
  local code=$?
  trap - ERR
  set +e
  log "deploy failed (exit $code) while $STATE"
  if [ "$STATE" = modified ]; then
    compose stop "$SERVICE" >/dev/null 2>&1
    log "restoring the n8n_data volume from backup $BACKUP_ID"
    restore_volume "$BK" || { log "RESTORE FAILED: restore by hand from $BK (README.md)"; exit 1; }
  fi
  if [ "$STATE" != running ]; then
    compose up -d "$SERVICE" >/dev/null 2>&1
    if wait_healthy; then
      log "n8n is back up on the previous workflows"
    else
      log "n8n did not become healthy after the restore: check it on the VM now"
    fi
  fi
  exit 1
}
trap on_failure ERR

log "stopping n8n"
compose stop "$SERVICE" >/dev/null 2>&1
STATE=stopped
archive_volume "$BK"
log "archived the n8n_data volume"

# 3. Import by id, then publish.
STAGE="$BK/import"
mkdir -p "$STAGE"
cp "${FILES[@]}" "$STAGE/"
chmod 755 "$STAGE"
chmod 644 "$STAGE"/*.json

STATE=modified
compose run --rm --no-deps -T -v "$STAGE:/import:ro" "$SERVICE" \
  import:workflow --separate --input=/import >"$BK/import.log" 2>&1
grep -iE 'imported' "$BK/import.log" | tail -n 1 || true

mapfile -t PUBLISH < <(printf '%s\n' "${IDS[@]}" | cat - "$BK/published-before.txt" | sort -u)
# shellcheck disable=SC2016  # $@ and $id expand inside the container
compose run --rm --no-deps -T --entrypoint sh "$SERVICE" -c '
  for id in "$@"; do n8n publish:workflow --id="$id" >/dev/null 2>&1 || { echo "publish failed: $id"; exit 1; }; done' \
  sh "${PUBLISH[@]}"
log "imported ${#IDS[@]} and published ${#PUBLISH[@]} workflows"

# 4. Start and check.
compose up -d "$SERVICE" >/dev/null 2>&1
wait_healthy || { log "n8n did not answer $HEALTH_URL"; false; }
published="$(published_ids)"
not_published=()
for id in "${IDS[@]}"; do
  grep -qx "$id" <<<"$published" || not_published+=("$id")
done
if [ "${#not_published[@]}" -gt 0 ]; then
  log "not published after start: ${not_published[*]}"
  false
fi

trap - ERR
printf '%s %s\n' "$SHA" "$BACKUP_ID" >"$BACKUP_ROOT/last-deployed"
rm -rf "$STAGE"
prune_backups
log "deployed ${SHA:0:7}; n8n healthy, ${#IDS[@]} workflows published. Undo: Rollback workflow with backup $BACKUP_ID"
