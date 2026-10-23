# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

n8n workflow definitions (exported JSON) plus supporting scripts for **Dr. Usama's Gastro & Hepatology Clinic**, a WhatsApp AI appointment-booking agent. WhatsApp messages are handled by an n8n LangChain agent that calls sub-workflow "tools" (Book/Cancel/Reschedule/Get/Search/CheckAvailability), which read and write appointment/doctor data directly in a **shared Supabase Postgres database** (also used by a separate `Dentalclinic-dashboard` sibling repo). There is no application database inside n8n — n8n's own SQLite only stores workflow/credential/execution platform data.

```
WhatsApp → n8n (agent + tool sub-workflows) → Supabase Postgres (single source of truth) → Clinic Dashboard
```

## Commands

```bash
npm test              # runs test:time + test:language + test:whatsapp
npm run test:time      # node scripts/test-time-format.js (lib/clinic-time.js unit tests)
npm run test:language  # node scripts/test-language-matching.js (validates agent systemMessage rules)
npm run test:whatsapp  # node scripts/test-whatsapp-routing.js (sender routing, number guard, workflow/tool ids)

python3 scripts/verify-shared-supabase-e2e.py   # full E2E lifecycle test against Supabase (book/cancel/reschedule/notifications)
node scripts/test-availability-supabase.js       # availability probe + booked-slot regression test
python3 scripts/verify-whatsapp-token.py --no-send  # read-only: token, sender number status, WABA health (drop --no-send to send a real test message)
```

Starting the local stack (Docker n8n + Cloudflare tunnel + WhatsApp webhook wiring):

```bash
./start-n8n-whatsapp.sh          # ALWAYS use this — never bare `docker run` or `docker compose up` directly
```

This script (`scripts/start-n8n.sh`) starts/reuses the n8n container on the `n8n_data` volume, opens a Cloudflare quick tunnel, rewrites `WEBHOOK_URL`/`N8N_EDITOR_BASE_URL` in `.env.docker` to the new tunnel URL, recreates the container only if that URL changed, syncs the WhatsApp credential into n8n's DB (`scripts/apply-whatsapp-auth.py`), and runs a container env + Supabase smoke-test verification. Re-run it any time the tunnel URL needs refreshing — it's idempotent and preserves the `n8n_data` volume.

There is no build/lint step; this is not a compiled application.

## Architecture

### Two completely separate deploy paths — do not mix them

- **Local development**: `docker-compose.yml` + `.env.docker` + `./start-n8n-whatsapp.sh`. Uses a Cloudflare quick tunnel for the WhatsApp webhook and `http://host.docker.internal:54321` to reach local Supabase.
- **Cloud/testing deploy** (`deploy/`): `deploy/docker-compose.prod.yml` + `deploy/Caddyfile` + `.env` (from `deploy/.env.production.example`) on an Oracle VM behind DuckDNS/Caddy TLS. Pinned to n8n `2.34.6` — do not run `:latest` against an existing volume (irreversible SQLite migration risk). Never run `start-n8n-whatsapp.sh` on the cloud VM (it would overwrite the real webhook URL with a tunnel). Migrating this environment is done by copying the `n8n_data` volume (`deploy/migrate-n8n-volume.sh`), not by re-importing the workflow JSON files, because that would lose hardcoded sub-workflow IDs and encrypted credentials.

### The n8n agent workflow

`WhatsApp AI Appointment Booking Agent.json` is the main workflow: `Gateway Webhook` (POST `/webhook/clinidesk-inbound`) → `Verify Gateway Secret` → `Normalize WhatsApp Message` → voice-note download and transcription (if audio) → `Clinic Context` → `Appointment Booking Agent` (LangChain agent, Groq chat model, buffer-window memory keyed `clinic_id:phone`) → tool sub-workflows → `Send WhatsApp Reply`. `Agent Error Fallback` (a Code node) salvages real tool results instead of fabricating a success/failure message when the agent's own reply generation errors out (e.g. on Groq rate limits).

**Multi-tenant via the CliniDesk gateway:** Meta's webhooks for every clinic's number go to the dashboard (`/api/whatsapp/webhook` in Dentalclinic-dashboard), never to n8n. The dashboard verifies Meta's signature, dedupes, resolves the clinic, applies the billing/usage gate and posts `{clinic_id, phone_number_id, from, text, media_id, context}` here with `X-CliniDesk-Secret`. `Clinic Context` is built entirely from that `context` (clinic, timezone, today, doctor, scope, services, fees, extra instructions) — nothing in the workflows names a clinic. Replies go to `$env.CLINIDESK_GATEWAY_URL/api/internal/whatsapp/send` and voice notes come from `/api/internal/whatsapp/media/{id}`. The dashboard holds each clinic's token, so the agent has no WhatsApp credential. `npm run test:whatsapp` enforces all of this.

The `Tool - *.json` files are sub-workflows invoked via `toolWorkflow` nodes from the main agent. Each talks to Supabase directly over PostgREST (`HTTP Request` nodes using `$env.SUPABASE_URL` / `$env.SUPABASE_SERVICE_ROLE_KEY`) — **never** via n8n Data Tables (those were purged; see `IMPLEMENTATION_REPORT.md`). Every query is scoped to the `clinic_id` tool input (`clinic_id=eq.{{ $('Execute Workflow Trigger').item.json.clinic_id }}`). The agent passes `clinic_id`, `timezone`, `cancellation_cutoff_minutes` and the patient's `phone_number` from `Clinic Context`, never from `$fromAI`. Code nodes read them as `TOOL_INPUT` and throw if `clinic_id` or `timezone` is missing. When editing or adding a tool workflow, keep this pattern.

`Send Notification.json` is legacy: it still sends from `$env.WHATSAPP_PHONE_NUMBER_ID` for the one clinic named by the dashboard's `LEGACY_WHATSAPP_CLINIC_ID`, until that clinic connects its number through the dashboard. Retire it after that cutover.

Editing workflow JSON directly: these files are n8n's export format. After editing, re-import them into n8n (UI import or via the MCP n8n tools if available) rather than hand-crafting node wiring blind — the JSON encodes node positions, connections by name, and expression bindings that are easy to break silently.

### Time handling

The DB stores appointment times as `HH:mm` 24-hour strings. `lib/clinic-time.js` (and its inline copy baked into the agent workflow's Code node, `scripts/clinic-time-snippet.js`) is the presentation-layer conversion boundary — it parses flexible input formats (`9:00 AM`, `21:00`, `9:00pm`, etc.) and formats for display in the clinic timezone (`Asia/Karachi`, from `CLINIC_TIMEZONE`). If you touch time parsing/formatting logic, update **both** `lib/clinic-time.js` and the snippet embedded in the workflow JSON — they must stay in sync since the workflow's Code node can't `require()` the lib file.

### Credentials and secrets

WhatsApp/OpenAI/SMTP secrets never live in workflow JSON (workflow JSON only references credential id/name/type). They're synced into n8n's own encrypted credential store from `.env`/`.env.docker` by two independent mechanisms:
- `scripts/apply-whatsapp-auth.py` writes the WhatsApp credential directly into n8n's SQLite via `scripts/n8n_crypto.py` (reimplements n8n's AES-256-CBC credential encryption).
- `scripts/build-credentials-overwrite.py` builds `config/credentials-overwrite.json` for `CREDENTIALS_OVERWRITE_DATA` (non-Docker/local process use).

`.env`, `.env.docker`, and `config/credentials-overwrite.json` are gitignored — never commit real secrets into them or into workflow JSON. `N8N_ENCRYPTION_KEY` must never be set manually in the cloud deploy env (see `deploy/README.md`).

### Supabase is the single source of truth — do not re-seed carelessly

Both n8n and the `Dentalclinic-dashboard` sibling repo read/write the same Supabase Postgres instance directly; there is no sync layer. `Dentalclinic-dashboard/scripts/seed-supabase.ts` and `supabase db reset` **delete all appointments** — never run these while testing live WhatsApp flows, only when you intentionally want a clean slate. See `SUPABASE_INTEGRATION.md` and `IMPLEMENTATION_REPORT.md` for the full data-flow history and verification commands.
