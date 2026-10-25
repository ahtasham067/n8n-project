#!/usr/bin/env bash
# Move the SQLite n8n (../docker-compose.prod.yml, container "n8n") to queue mode.
#
# Workflow ids, credential ids and the encryption key are kept, so the agent's
# hardcoded sub-workflow ids keep working and saved credentials still decrypt.
# The old n8n_data volume is never modified: rollback is "stop this stack,
# start the old one".
#
# Run on the VM from this folder, with .env filled in (all but N8N_ENCRYPTION_KEY):
#   ./migrate-sqlite-to-queue.sh
set -euo pipefail

cd "$(dirname "$0")"
OLD=${OLD_CONTAINER:-n8n}
COMPOSE=(docker compose -f docker-compose.queue.yml)
WORK=./migration
mkdir -p "$WORK"
chmod 700 "$WORK"

[ -f .env ] || { echo "Create .env from .env.queue.example first." >&2; exit 1; }
docker inspect "$OLD" >/dev/null 2>&1 || { echo "No container named $OLD." >&2; exit 1; }

echo "1/6 Export workflows, credentials (still encrypted) and the active list from $OLD"
docker exec "$OLD" sh -c 'rm -rf /tmp/mig && mkdir -p /tmp/mig &&
  n8n export:workflow --all --output=/tmp/mig/workflows.json &&
  n8n export:credentials --all --output=/tmp/mig/credentials.json &&
  n8n list:workflow --active=true --onlyId > /tmp/mig/active.txt'
docker cp "$OLD:/tmp/mig/." "$WORK/"
docker exec "$OLD" rm -rf /tmp/mig
grep -E '^[A-Za-z0-9]+$' "$WORK/active.txt" > "$WORK/active-ids.txt" || true
echo "   $(wc -l < "$WORK/active-ids.txt") active workflows"

echo "2/6 Copy the encryption key into .env (not printed)"
KEY=$(docker exec "$OLD" sh -c 'cat /home/node/.n8n/config' | sed -n 's/.*"encryptionKey"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
[ -n "$KEY" ] || { echo "Could not read encryptionKey from $OLD." >&2; exit 1; }
if grep -q '^N8N_ENCRYPTION_KEY=.\+' .env; then
  grep -q "^N8N_ENCRYPTION_KEY=$KEY\$" .env || { echo ".env has a different N8N_ENCRYPTION_KEY; remove it and rerun." >&2; exit 1; }
else
  sed -i '/^N8N_ENCRYPTION_KEY=/d' .env
  echo "N8N_ENCRYPTION_KEY=$KEY" >> .env
fi

echo "3/6 Start Postgres, Redis and the main process"
"${COMPOSE[@]}" up -d postgres redis n8n-main
until [ "$(docker inspect -f '{{.State.Health.Status}}' "$("${COMPOSE[@]}" ps -q n8n-main)")" = healthy ]; do sleep 3; done
MAIN=$("${COMPOSE[@]}" ps -q n8n-main)

echo "4/6 Import (ids are kept)"
docker cp "$WORK/." "$MAIN:/tmp/mig"
docker exec "$MAIN" n8n import:credentials --input=/tmp/mig/credentials.json
docker exec "$MAIN" n8n import:workflow --input=/tmp/mig/workflows.json

echo "5/6 Publish: everything that was active, plus every sub-workflow"
# n8n 2.x refuses to run a sub-workflow (Execute Workflow Trigger) that isn't published.
{
  cat "$WORK/active-ids.txt"
  docker exec "$MAIN" n8n list:workflow | grep -E '^[A-Za-z0-9]+\|(Tool - |WhatsApp Booking Error Handler)' | cut -d'|' -f1
} | sort -u | while read -r id; do
  docker exec "$MAIN" n8n publish:workflow --id="$id" >/dev/null
  echo "   published $id"
done
docker exec "$MAIN" rm -rf /tmp/mig

echo "6/6 Ready to switch over"
cat <<'EOF'
The old instance is still running and still owns the webhooks. To switch:

  docker stop n8n caddy                       # old stack (volume untouched)
  docker compose -f docker-compose.queue.yml restart n8n-main
  docker compose -f docker-compose.queue.yml up -d n8n-worker
  docker compose -f docker-compose.queue.yml --profile tls up -d caddy

Then point the dashboard's N8N_INBOUND_URL at the new host if it changed, send
a WhatsApp test message, and check `docker compose ... logs n8n-worker`.

Rollback:
  docker compose -f docker-compose.queue.yml --profile tls down
  docker start n8n caddy

Delete ./migration once the new stack has run for a few days: credentials.json
is encrypted, but workflows.json holds the prompts.
EOF
