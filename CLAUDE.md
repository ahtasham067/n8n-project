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
- **Queue mode** (`deploy/queue/`): Postgres + Redis + `n8n-main` + scalable `n8n-worker`, with `migrate-sqlite-to-queue.sh` to move the SQLite deployment over keeping ids and the encryption key. See `deploy/queue/README.md`.
- **Cloud/testing deploy** (`deploy/`): `deploy/docker-compose.prod.yml` + `deploy/Caddyfile` + `.env` (from `deploy/.env.production.example`) on an Oracle VM behind DuckDNS/Caddy TLS. Pinned to n8n `2.34.6` — do not run `:latest` against an existing volume (irreversible SQLite migration risk). Never run `start-n8n-whatsapp.sh` on the cloud VM (it would overwrite the real webhook URL with a tunnel). Migrating this environment is done by copying the `n8n_data` volume (`deploy/migrate-n8n-volume.sh`), not by re-importing the workflow JSON files, because that would lose hardcoded sub-workflow IDs and encrypted credentials.

### The n8n agent workflow

`WhatsApp AI Appointment Booking Agent.json` is the main workflow: `Gateway Webhook` (POST `/webhook/clinidesk-inbound`) → `Verify Gateway Secret` → `Normalize WhatsApp Message` → voice-note download and transcription (if audio) → `Clinic Context` → `Appointment Booking Agent` (LangChain agent, OpenAI-compatible chat model pointed at the dashboard's LLM proxy, **no memory node**) → tool sub-workflows → `Send WhatsApp Reply`. `Agent Error Fallback` (a Code node) salvages real tool results instead of fabricating a success/failure message when the agent's own reply generation errors out (e.g. on Groq rate limits).

**Multi-tenant via the CliniDesk gateway:** Meta's webhooks for every clinic's number go to the dashboard (`/api/whatsapp/webhook` in Dentalclinic-dashboard), never to n8n. The dashboard verifies Meta's signature, dedupes, resolves the clinic, applies the billing/usage gate and posts `{clinic_id, phone_number_id, from, text, media_id, context}` here with `X-CliniDesk-Secret`. `Clinic Context` is built entirely from that `context` (clinic, timezone, today, doctor, scope, services, fees, extra instructions) — nothing in the workflows names a clinic. Replies go to `$env.CLINIDESK_GATEWAY_URL/api/internal/whatsapp/send` and voice notes come from `/api/internal/whatsapp/media/{id}`. The dashboard holds each clinic's token, so the agent has no WhatsApp credential. `npm run test:whatsapp` enforces all of this.

**LLM calls go through the dashboard too:** `CliniDesk Chat Model` and `CliniDesk Fallback Chat Model` are OpenAI-compatible model nodes whose base URL is `$env.CLINIDESK_GATEWAY_URL/api/internal/llm/<clinic_id>/v1`, and `Transcribe Voice Note` posts there as well. The dashboard holds the Groq (and fallback) key and records tokens per clinic for /platform. n8n needs one credential, an OpenAI credential named **CliniDesk LLM proxy** (id `CliniDeskLlmProxy`) whose API key is the value of `CLINIDESK_GATEWAY_SECRET`; it holds no Groq key. Keep both model nodes at **typeVersion 1**: from 1.1 the node hides the Base URL option and n8n silently drops it, so calls go to api.openai.com instead (found by the queue-mode smoke test; `npm run test:whatsapp` checks it).

**Chat history comes from the gateway:** every forwarded message carries `history`, the last day of the chat (patient, assistant, staff from the phone or the dashboard inbox, clinic notices). `Normalize WhatsApp Message` turns it into `history_text` and the prompt shows it as CONVERSATION SO FAR. That replaces n8n's in-process memory, so any queue-mode worker can answer any message (`deploy/queue/`). `Send WhatsApp Reply` hands back `inbound_wamid` and, for a voice note, the transcript (`inbound_text`), so the next turn and the inbox see the words.

**Human takeover:** staff may reply from the clinic phone (coexistence) or from the dashboard inbox. The gateway then stops forwarding that patient's messages for a while, and the next forwarded message's history shows what staff said, so the bot continues from them. `Send WhatsApp Reply` passes `inbound_received_at`; if staff replied after that message, the gateway answers `200 {skipped}` and nothing is sent.

The `Tool - *.json` files are sub-workflows invoked via `toolWorkflow` nodes from the main agent. Each talks to Supabase directly over PostgREST (`HTTP Request` nodes using `$env.SUPABASE_URL` / `$env.SUPABASE_SERVICE_ROLE_KEY`) — **never** via n8n Data Tables (those were purged; see `IMPLEMENTATION_REPORT.md`). Every query is scoped to the `clinic_id` tool input (`clinic_id=eq.{{ $('Execute Workflow Trigger').item.json.clinic_id }}`). The agent passes `clinic_id`, `timezone`, `cancellation_cutoff_minutes` and the patient's `phone_number` from `Clinic Context`, never from `$fromAI`. Code nodes read them as `TOOL_INPUT` and throw if `clinic_id` or `timezone` is missing. When editing or adding a tool workflow, keep this pattern.

**Several doctors per clinic:** the doctor tools are thin wrappers around the dashboard's `bot_*` RPCs (`Execute Workflow Trigger` → one HTTP POST to `/rest/v1/rpc/bot_…`), so matching, leave, capacity and duplicate rules live in SQL (`Dentalclinic-dashboard/supabase/migrations/20261029100000_multi_doctor.sql`). `FindDoctor` (`bot_find_doctors`: name, Roman Urdu or Urdu spelling, alias, specialty, problem, optional gender), `GetDoctorDetails` (`bot_doctor_details`), `CheckDoctorAvailability` (`bot_doctor_availability`: `on_leave`, `fully_booked`, next dates, same-specialty alternatives), `FindEarliestSlots` (`bot_earliest_slots`), `BookAppointment` (`bot_book_appointment`, hourly window or earliest; asks before a same-doctor same-day duplicate) and `RescheduleAppointment` (`bot_reschedule`, optionally to another doctor). The model fills `doctor_id`; the RPCs refuse a doctor who is inactive, hidden from WhatsApp or in another clinic, and in a one-doctor clinic they use that doctor whatever id is sent. `Clinic Context` gets `doctor_count`, `doctors_roster` and `selection_text` (the doctor and date this patient last picked, stored in `conversation_state`), and the system prompt switches on `Number(doctor_count) > 1`, so single-doctor clinics keep the short prompt.

`CliniDesk Scheduler.json` runs the dashboard's frequent crons: Vercel Hobby runs crons at most once a day, so every 15 minutes it calls `$env.CLINIDESK_GATEWAY_URL/api/cron/platform-alerts` with `Authorization: Bearer $env.CLINIDESK_CRON_SECRET` (the dashboard's `CRON_SECRET`). Those calls also keep a Supabase Free project from pausing. It names no host, secret or number; `npm run test:whatsapp` checks that. On an existing instance it is the one workflow that is imported (it's new), then published.

`Send Notification.json` is legacy: it still sends from `$env.WHATSAPP_PHONE_NUMBER_ID` for the one clinic named by the dashboard's `LEGACY_WHATSAPP_CLINIC_ID`, until that clinic connects its number through the dashboard. Retire it after that cutover.

Every workflow file has a fixed top-level `id` matching what the agent's `toolWorkflow` nodes and `errorWorkflow` setting reference, so a **fresh** instance (queue mode, standalone install) can import them with `n8n import:workflow --separate`. n8n 2.x only runs a sub-workflow that is **published**, so publish every `Tool - *` workflow and the error handler too (`n8n publish:workflow --id=…`, then restart). An existing instance is still updated in place, never by re-import (`PRODUCTION_UPDATE.md`).

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
