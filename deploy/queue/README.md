# n8n queue mode (CliniDesk)

One n8n process runs everything until it can't keep up (roughly 10–20 agent
runs at once). Queue mode splits that: the **main** process serves the editor
and the webhook, puts each execution on a **Redis** queue, and **workers** run
them. n8n's own data moves from SQLite to **Postgres** (a small database in
this stack, not the app database).

| File | Purpose |
| --- | --- |
| `docker-compose.queue.yml` | Postgres 16, Redis 7, `n8n-main`, `n8n-worker` (scale it), Caddy (`--profile tls`) |
| `.env.queue.example` | Copy to `.env`; queue passwords, the shared encryption key, URLs, Supabase, gateway |
| `Caddyfile` | TLS for `CADDY_HOST` in front of `n8n-main` |
| `migrate-sqlite-to-queue.sh` | Moves the SQLite deployment over, keeping workflow ids, credential ids and the encryption key |

## Why several workers are safe

The agent keeps **no chat memory of its own**. The dashboard gateway sends the
last day of the chat with every message (`history`), so a patient's second
message can land on a different worker than the first. In-process memory
(n8n's "Simple Memory") would break here.

## Moving from the SQLite deployment

1. Back up first: `../migrate-n8n-volume.sh` (or `docker run --rm -v n8n_data:/d -v $PWD:/b alpine tar czf /b/n8n_data.tgz -C /d .`).
2. `cp .env.queue.example .env && chmod 600 .env`, then fill in everything **except** `N8N_ENCRYPTION_KEY`.
3. `./migrate-sqlite-to-queue.sh`. It exports workflows and credentials from the running `n8n` container and copies its encryption key into `.env`. It starts Postgres, Redis and `n8n-main`, imports everything, and publishes every workflow that was active plus every sub-workflow.
4. Switch over with the commands the script prints. The old container and its volume are left alone, so rollback is `down` here and `docker start n8n caddy` there.

## Fresh install (no existing n8n)

```bash
cp .env.queue.example .env && chmod 600 .env   # set N8N_ENCRYPTION_KEY=$(openssl rand -hex 24)
docker compose -f docker-compose.queue.yml up -d postgres redis n8n-main
MAIN=$(docker compose -f docker-compose.queue.yml ps -q n8n-main)
docker cp ../../. "$MAIN":/tmp/repo        # or copy just the workflow JSON files
docker exec "$MAIN" sh -c 'mkdir -p /tmp/wf && cp /tmp/repo/"WhatsApp AI Appointment Booking Agent.json" /tmp/repo/Tool\ -\ *.json /tmp/repo/"WhatsApp Booking Error Handler.json" /tmp/wf/ && n8n import:workflow --separate --input=/tmp/wf'
```

Then create the **CliniDesk LLM proxy** credential (OpenAI type, API key =
`CLINIDESK_GATEWAY_SECRET`; its id must be `CliniDeskLlmProxy`, or reselect it
on both chat model nodes). Publish every imported workflow
(`n8n publish:workflow --id=…` for each id from `n8n list:workflow`), restart
`n8n-main`, and start the workers. Every workflow file has a fixed `id`, so the
agent finds its tools on a fresh instance.

## Operating it

- Scale: `docker compose -f docker-compose.queue.yml up -d --scale n8n-worker=3`.
- Health: each process answers `GET /healthz` on 5678 (inside the network); `docker compose ps` shows it.
- Logs: `docker compose -f docker-compose.queue.yml logs -f n8n-worker`.
- Upgrades: bump the image tag on **both** `n8n-main` and `n8n-worker` together, after a Postgres dump (`docker compose exec postgres pg_dump -U n8n n8n > n8n.sql`).

## Verified locally (2026-10-23)

A throwaway copy of this stack (own project name, volumes and port) was tested
against the local dashboard and Supabase, with a mock LLM and a mock Graph API.
Signed Meta webhook → gateway → `n8n-main` → Redis → worker → agent → LLM proxy
→ `FindDoctor` → `bot_find_doctors` → reply via `/api/internal/whatsapp/send`.
Six patients at once were answered in 4–7 s, split across two workers. The
second turn's prompt carried the history, and the proxy metered every LLM call
per clinic.
