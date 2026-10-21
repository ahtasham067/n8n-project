#!/usr/bin/env bash
# Start the full local n8n + Cloudflare tunnel + WhatsApp stack.
# Never use bare `docker run` — it drops Supabase env. WhatsApp secrets live in
# n8n Credentials (synced from .env.docker via scripts/apply-whatsapp-auth.py).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RUN_DIR="$ROOT/.run"
CLOUDFLARED_LOG="$RUN_DIR/cloudflared.log"
CLOUDFLARED_PID_FILE="$RUN_DIR/cloudflared.pid"
N8N_PORT=5678
N8N_HEALTH_URL="http://127.0.0.1:${N8N_PORT}/healthz"

die() {
  echo "ERROR: $*" >&2
  exit 1
}

info() {
  echo "$*"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is not installed or not on PATH."
}

ensure_env_file() {
  if [[ ! -f .env.docker ]]; then
    die "Missing .env.docker — copy from .env.example and fill Supabase + WhatsApp values."
  fi
}

ensure_docker() {
  require_command docker
  docker info >/dev/null 2>&1 || die "Docker is not running. Start Docker and retry."
  require_command curl
}

ensure_port_available() {
  if curl -sf "$N8N_HEALTH_URL" >/dev/null 2>&1; then
    return 0
  fi

  if docker ps --format '{{.Names}}' | grep -qx n8n; then
    info "n8n container exists but is not healthy yet; continuing startup..."
    return 0
  fi

  if command -v ss >/dev/null 2>&1; then
    if ss -ltn "( sport = :${N8N_PORT} )" 2>/dev/null | grep -q ":${N8N_PORT}"; then
      die "Port ${N8N_PORT} is in use by another process and n8n is not healthy at ${N8N_HEALTH_URL}."
    fi
  elif command -v lsof >/dev/null 2>&1; then
    if lsof -iTCP:"${N8N_PORT}" -sTCP:LISTEN -t >/dev/null 2>&1; then
      die "Port ${N8N_PORT} is in use by another process and n8n is not healthy at ${N8N_HEALTH_URL}."
    fi
  fi
}

normalize_tunnel_url() {
  local url="${1%/}"
  printf '%s/\n' "$url"
}

update_env_docker_urls() {
  local url
  url="$(normalize_tunnel_url "$1")"

  if grep -q '^WEBHOOK_URL=' .env.docker; then
    sed -i "s|^WEBHOOK_URL=.*|WEBHOOK_URL=${url}|" .env.docker
  else
    echo "WEBHOOK_URL=${url}" >> .env.docker
  fi

  if grep -q '^N8N_EDITOR_BASE_URL=' .env.docker; then
    sed -i "s|^N8N_EDITOR_BASE_URL=.*|N8N_EDITOR_BASE_URL=${url}|" .env.docker
  else
    echo "N8N_EDITOR_BASE_URL=${url}" >> .env.docker
  fi
}

remove_misconfigured_n8n_container() {
  if ! docker ps -a --format '{{.Names}}' | grep -qx n8n; then
    return 0
  fi

  if docker exec n8n sh -c 'test -n "$SUPABASE_URL" && test -n "$SUPABASE_SERVICE_ROLE_KEY"' >/dev/null 2>&1; then
    return 0
  fi

  info "Removing misconfigured n8n container (missing SUPABASE_* env)..."
  docker stop n8n >/dev/null 2>&1 || true
  docker rm n8n >/dev/null 2>&1 || true
}

stop_cloudflared() {
  if [[ -f "$CLOUDFLARED_PID_FILE" ]]; then
    local pid
    pid="$(cat "$CLOUDFLARED_PID_FILE")"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      info "Stopping previous cloudflared (PID ${pid})..."
      kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 10); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.5
      done
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$CLOUDFLARED_PID_FILE"
  fi

  local pid
  while read -r pid; do
    [[ -z "$pid" ]] && continue
    info "Stopping orphaned cloudflared for localhost:${N8N_PORT} (PID ${pid})..."
    kill "$pid" 2>/dev/null || true
  done < <(pgrep -f "cloudflared tunnel --url http://localhost:${N8N_PORT}" 2>/dev/null || true)
}

start_cloudflared() {
  require_command cloudflared
  mkdir -p "$RUN_DIR"
  : >"$CLOUDFLARED_LOG"

  info "Starting Cloudflare quick tunnel -> http://localhost:${N8N_PORT}"
  nohup cloudflared tunnel --url "http://localhost:${N8N_PORT}" >>"$CLOUDFLARED_LOG" 2>&1 &
  local pid=$!
  echo "$pid" >"$CLOUDFLARED_PID_FILE"
  disown "$pid" 2>/dev/null || true
}

detect_tunnel_url() {
  local url=""
  for _ in $(seq 1 60); do
    url="$(
      grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$CLOUDFLARED_LOG" 2>/dev/null | head -1 || true
    )"
    if [[ -n "$url" ]]; then
      normalize_tunnel_url "$url"
      return 0
    fi

    if [[ -f "$CLOUDFLARED_PID_FILE" ]]; then
      local pid
      pid="$(cat "$CLOUDFLARED_PID_FILE")"
      if ! kill -0 "$pid" 2>/dev/null; then
        die "cloudflared exited before publishing a trycloudflare.com URL. Log:\n$(tail -20 "$CLOUDFLARED_LOG" 2>/dev/null || true)"
      fi
    fi
    sleep 1
  done

  die "Timed out waiting for trycloudflare.com URL. Log:\n$(tail -30 "$CLOUDFLARED_LOG" 2>/dev/null || true)"
}

wait_for_n8n() {
  info "Waiting for n8n on ${N8N_HEALTH_URL}..."
  for _ in $(seq 1 60); do
    if curl -sf "$N8N_HEALTH_URL" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  die "Timed out waiting for n8n health check at ${N8N_HEALTH_URL}."
}

remove_n8n_container_only() {
  if docker ps -a --format '{{.Names}}' | grep -qx n8n; then
    info "Removing existing n8n container (volume n8n_data is preserved)..."
    docker stop n8n >/dev/null 2>&1 || true
    docker rm n8n >/dev/null 2>&1 || true
  fi
}

start_n8n_container() {
  local mode="${1:-}"

  if [[ "$mode" == "--force-recreate" ]]; then
    remove_n8n_container_only
    docker compose up -d --force-recreate --remove-orphans
    wait_for_n8n
    return 0
  fi

  if docker ps --format '{{.Names}}' | grep -qx n8n; then
    wait_for_n8n
    return 0
  fi

  if docker ps -a --format '{{.Names}}' | grep -qx n8n; then
    info "Starting existing n8n container..."
    docker start n8n >/dev/null
    wait_for_n8n
    return 0
  fi

  docker compose up -d --remove-orphans
  wait_for_n8n
}

ensure_n8n_running() {
  if curl -sf "$N8N_HEALTH_URL" >/dev/null 2>&1; then
    info "n8n already healthy at ${N8N_HEALTH_URL}"
    return 0
  fi
  info "Starting n8n (Docker Compose, volume: n8n_data)..."
  start_n8n_container
}

recreate_n8n_if_url_changed() {
  local desired_url="$1"
  local current_url=""
  if docker ps --format '{{.Names}}' | grep -qx n8n; then
    current_url="$(docker exec n8n printenv WEBHOOK_URL 2>/dev/null || true)"
  fi

  if [[ "$(normalize_tunnel_url "${current_url:-}")" == "$desired_url" ]]; then
    info "WEBHOOK_URL already set to ${desired_url}; skipping n8n recreate"
    return 0
  fi

  info "Recreating n8n with updated WEBHOOK_URL..."
  start_n8n_container --force-recreate
}

sync_whatsapp_credential() {
  set -a
  # shellcheck disable=SC1091
  source .env.docker
  set +a

  if [[ -z "${WHATSAPP_ACCESS_TOKEN:-}" || "${WHATSAPP_ACCESS_TOKEN}" == your-* ]]; then
    info "WARN: WHATSAPP_ACCESS_TOKEN not set in .env.docker — Send WhatsApp Reply will fail."
    info "      Add a Meta System User token, then: python3 scripts/verify-whatsapp-token.py"
    return 0
  fi

  info "Syncing WhatsApp API credential in n8n database..."
  python3 "$ROOT/scripts/apply-whatsapp-auth.py"
}

verify_stack() {
  local tunnel_url="${1:-}"

  info "Verifying container env..."
  docker exec n8n sh -c '
    test -n "$SUPABASE_URL" || { echo "FAIL: SUPABASE_URL empty"; exit 1; }
    test -n "$SUPABASE_SERVICE_ROLE_KEY" || { echo "FAIL: SUPABASE_SERVICE_ROLE_KEY empty"; exit 1; }
    test "$N8N_BLOCK_ENV_ACCESS_IN_NODE" = "false" || { echo "FAIL: N8N_BLOCK_ENV_ACCESS_IN_NODE must be false"; exit 1; }
    test -n "$WEBHOOK_URL" || { echo "FAIL: WEBHOOK_URL empty"; exit 1; }
    test -n "$N8N_EDITOR_BASE_URL" || { echo "FAIL: N8N_EDITOR_BASE_URL empty"; exit 1; }
    echo "SUPABASE_URL=$SUPABASE_URL"
    echo "WEBHOOK_URL=$WEBHOOK_URL"
    echo "N8N_EDITOR_BASE_URL=$N8N_EDITOR_BASE_URL"
    echo "N8N_BLOCK_ENV_ACCESS_IN_NODE=$N8N_BLOCK_ENV_ACCESS_IN_NODE"
    echo "WHATSAPP_PHONE_NUMBER_ID=${WHATSAPP_PHONE_NUMBER_ID:-}"
    echo "WHATSAPP_ALLOWED_PHONE_NUMBER_IDS=${WHATSAPP_ALLOWED_PHONE_NUMBER_IDS:-}"
    test -n "$WHATSAPP_PHONE_NUMBER_ID" || echo "WARN: WHATSAPP_PHONE_NUMBER_ID empty — Send Notification has no sender (see .env.example)"
    test -n "$WHATSAPP_ALLOWED_PHONE_NUMBER_IDS" || echo "WARN: WHATSAPP_ALLOWED_PHONE_NUMBER_IDS empty — this instance answers EVERY number subscribed to the Meta app"
  '

  local mount
  mount="$(docker inspect n8n --format '{{range .Mounts}}{{if eq .Destination "/home/node/.n8n"}}{{.Name}}{{end}}{{end}}')"
  [[ "$mount" == "n8n_data" ]] || die "Expected n8n_data volume mount, got: ${mount:-none}"

  local workflow_count
  workflow_count="$(
    docker exec n8n sh -c 'command -v sqlite3 >/dev/null && sqlite3 /home/node/.n8n/database.sqlite "SELECT COUNT(*) FROM workflow_entity;" 2>/dev/null || echo unknown'
  )"
  info "Workflows in n8n_data volume: ${workflow_count}"

  if [[ -n "$tunnel_url" ]]; then
    info "Verifying tunnel URL reaches n8n..."
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' "${tunnel_url%/}/healthz" || true)"
    [[ "$code" == "200" ]] || die "Tunnel health check failed (${tunnel_url%/}/healthz returned HTTP ${code:-000})."
  fi

  if [[ -f "$CLOUDFLARED_PID_FILE" ]]; then
    local pid
    pid="$(cat "$CLOUDFLARED_PID_FILE")"
    kill -0 "$pid" 2>/dev/null || die "cloudflared is not running (PID ${pid})."
    info "cloudflared running (PID ${pid})"
  fi

  info "Smoke test: doctors query from inside container..."
  docker exec n8n sh -c '
    wget -qO- \
      --header="apikey: $SUPABASE_SERVICE_ROLE_KEY" \
      --header="Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
      "$SUPABASE_URL/rest/v1/doctors?clinic_id=eq.CLINIC-SMILECARE&doctor_id=eq.DOC-003&select=doctor_id,doctor_name" \
      | head -c 200
  '
  echo
}

main() {
  ensure_env_file
  ensure_docker
  ensure_port_available
  remove_misconfigured_n8n_container
  stop_cloudflared

  mkdir -p "$RUN_DIR"

  local tunnel_url=""
  if [[ -n "${TUNNEL_URL:-}" ]]; then
    tunnel_url="$(normalize_tunnel_url "$TUNNEL_URL")"
    info "Using TUNNEL_URL override: ${tunnel_url}"
    update_env_docker_urls "$tunnel_url"
  fi

  ensure_n8n_running

  if [[ -z "${TUNNEL_URL:-}" ]]; then
    start_cloudflared
    tunnel_url="$(detect_tunnel_url)"
    info "Detected Cloudflare URL: ${tunnel_url}"
    update_env_docker_urls "$tunnel_url"
    recreate_n8n_if_url_changed "$tunnel_url"
  else
    update_env_docker_urls "$tunnel_url"
    recreate_n8n_if_url_changed "$tunnel_url"
  fi

  sync_whatsapp_credential
  verify_stack "$tunnel_url"

  cat <<EOF

Ready.
  Local n8n:   http://localhost:${N8N_PORT}
  Public URL:  ${tunnel_url}
  Tunnel log:  ${CLOUDFLARED_LOG}
  Tunnel PID:  $(cat "$CLOUDFLARED_PID_FILE" 2>/dev/null || echo n/a)

cloudflared stays running in the background. Re-run ./start-n8n-whatsapp.sh anytime to refresh the tunnel URL and recreate n8n safely.
EOF
}

main "$@"
