# n8n ↔ Supabase (Clinic Desk)

**Architecture:** WhatsApp → n8n → **local Supabase** (single source of truth) → SmileCare Clinic Dashboard.

Both **n8n** and the **dashboard** read and write the **same Supabase PostgreSQL database** directly. There is **no second application database** and **no sync layer**.

```text
                    ONE SHARED DATABASE
                         Supabase
                            │
             ┌──────────────┴──────────────┐
             │                             │
             ▼                             ▼
            n8n                  SmileCare Dashboard
             │                             │
             ▼                             ▼
         WhatsApp              Notifications + Board
```

**n8n internal SQLite** (`n8n_data` Docker volume) stores only n8n platform data (workflows, credentials, executions). It is **not** the SmileCare application database.

Tool workflows (`Tool - Book/Cancel/Reschedule/Get/Availability/Search`) read and write SmileCare data **only** via PostgREST + service role (`$env.SUPABASE_URL` / `$env.SUPABASE_SERVICE_ROLE_KEY`).

## Shared database (verified 2026-08-23)

| System | Connection | SmileCare app data? |
|--------|------------|---------------------|
| **SmileCare Dashboard** | `http://127.0.0.1:54321` (Supabase JS + Realtime) | **Yes — primary** |
| **n8n (Docker)** | `http://host.docker.internal:54321` (HTTP Request tools) | **Yes — same DB** |
| **n8n internal SQLite** | `/home/node/.n8n/database.sqlite` in `n8n_data` volume | **No** (platform only) |
| **n8n Data Tables** `Appointments` / `Doctors` | **Removed** (purged 2026-08-23; MCP count 0) |

| Postgres tables (shared) | Purpose |
|--------------------------|---------|
| `doctors` | Doctor records, hours, slot duration |
| `appointments` | Bookings, cancellations, reschedules |
| `notifications` | Dashboard alerts (DB trigger on `appointments`) |

Dashboard notifications fire automatically when n8n writes to `appointments` (INSERT = booked, PATCH status = cancelled, PATCH date/time = rescheduled). n8n does **not** write to `notifications` directly.

## Legacy n8n Data Tables (purged 2026-08-23)

Before Supabase migration, appointments/doctors lived in n8n Data Tables (19 orphaned test rows, pre-`CLINIC-SMILECARE` / `DOC-001` era). **Live workflows never used them after migration.** Rows were **exported** (`backups/legacy-data-tables-export.json`), **not migrated** (stale prototype data), and **purged** from SQLite via `scripts/purge-legacy-data-tables.sh`.

MCP audit `search_data_tables` → **count: 0**. n8n UI Data → Data Tables should show no `Appointments` / `Doctors` tables.

Volume backup before purge: `backups/n8n_data-20260823.tar.gz`.

## Start n8n (Docker Compose)

From this repo (`n8n-project`):

1. Ensure local Supabase is up in `Dentalclinic-dashboard` (`npx supabase start`).
2. Refresh `.env.docker` from `npx supabase status` (service role key). Template: `.env.example`. **Do not commit** `.env.docker`.
3. Start the full stack (n8n + Cloudflare tunnel + auto `WEBHOOK_URL`) — **always use the script** (never bare `docker run`):

```bash
./start-n8n-whatsapp.sh
```

Or manually:

```bash
docker compose up -d --force-recreate
```

Compose loads `.env.docker`, maps port `5678`, adds `host.docker.internal:host-gateway`, and reuses the existing `n8n_data` volume (workflows preserved).

Verify:

```bash
docker exec n8n printenv SUPABASE_URL
# expect: http://host.docker.internal:54321
docker exec n8n printenv N8N_BLOCK_ENV_ACCESS_IN_NODE
# expect: false
```

Open http://localhost:5678

### Required env (in `.env.docker` for Docker)

```bash
SUPABASE_URL=http://host.docker.internal:54321
SUPABASE_SERVICE_ROLE_KEY=<from npx supabase status in Dentalclinic-dashboard>
N8N_BLOCK_ENV_ACCESS_IN_NODE=false
```

`N8N_BLOCK_ENV_ACCESS_IN_NODE=false` is required so HTTP Request nodes can use `$env.SUPABASE_URL` / `$env.SUPABASE_SERVICE_ROLE_KEY`.

For a **non-Docker** n8n process, use `SUPABASE_URL=http://127.0.0.1:54321` in `.env` instead.

**Never** put the service role key in workflow JSON or the Next.js frontend.

## Import / re-import

1. Start local Supabase + seed in `Dentalclinic-dashboard`.
2. `docker compose up -d` with a current `.env.docker`.
3. Re-import (or replace) these workflows from this repo:
   - `Tool - Book Appointment.json`
   - `Tool - Cancel Appointment.json`
   - `Tool - Reschedule Appointment.json`
   - `Tool - Get Appointment.json`
   - `Tool - Check Doctor Availability.json`
   - `Tool - Search Doctors.json`
   - `WhatsApp AI Appointment Booking Agent.json` (adds `clinic_id: CLINIC-SMILECARE`)

After re-import, activate the tool workflows. Confirm **HTTP Request** nodes (not Data Table nodes) are present.

## Clinic pin

All tool queries filter `clinic_id=eq.CLINIC-SMILECARE` so the service role cannot touch other clinics.

## Do not re-seed during WhatsApp testing

`scripts/seed-supabase.ts` in `Dentalclinic-dashboard` **deletes all appointments** before inserting demo seed rows. Running it (or `supabase db reset`) **erases real WhatsApp bookings** and dashboard notifications.

While testing live WhatsApp flows, **do not** run:

```bash
# Requires explicit opt-in — blocks accidental wipe
ALLOW_SUPABASE_SEED=1 npx tsx scripts/seed-supabase.ts
```

Also avoid `npx supabase db reset` unless you intentionally want a clean slate.

The WhatsApp agent now receives `clinic_today` / `clinic_year` on every message, and Book / Check Availability / Reschedule tools **reject past dates** (e.g. 2024 when today is 2026).

## Double-booking

Postgres unique index `appointments_active_slot_uidx` rejects concurrent bookings for the same doctor/slot (non-cancelled). The Book tool maps that conflict to a friendly “slot taken” response.

## WhatsApp webhook

Meta must call a **public** URL that tunnels to n8n (Cloudflare Tunnel / ngrok). Dashboard and Supabase stay private on localhost.

WhatsApp agent activation requires a live tunnel + valid WhatsApp OAuth / System User token. Re-run `./start-n8n-whatsapp.sh` whenever the tunnel URL changes; the script detects the new `trycloudflare.com` URL, updates `WEBHOOK_URL`, and recreates n8n while preserving the `n8n_data` volume.

## Local test without Meta

Use n8n MCP `test_workflow` (or UI Execute) on `Tool - Book/Cancel/Reschedule Appointment` with pin data for the Execute Workflow Trigger. Confirm rows in Studio and live desk notifications.

### Verify shared database (quick checks)

```bash
# Same Supabase from host
curl -s "http://127.0.0.1:54321/rest/v1/doctors?clinic_id=eq.CLINIC-SMILECARE&limit=1" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"

# Same Supabase from n8n container
docker exec n8n node -e "fetch('http://host.docker.internal:54321/rest/v1/doctors?clinic_id=eq.CLINIC-SMILECARE&limit=1',{headers:{apikey:process.env.SUPABASE_SERVICE_ROLE_KEY,Authorization:'Bearer '+process.env.SUPABASE_SERVICE_ROLE_KEY}}).then(r=>r.text()).then(console.log)"

# Refresh service role from local Supabase
cd ../Dentalclinic-dashboard && npx supabase status
```

All six tool workflows must use **HTTP Request** nodes with `$env.SUPABASE_URL` — zero `dataTable` nodes.

### E2E lifecycle verification

Run the shared-database lifecycle test (availability → book 1:30 PM → double-book block → reschedule → cancel → notifications):

```bash
python3 scripts/verify-shared-supabase-e2e.py
# expect: OVERALL PASS
```

Full implementation audit: [`IMPLEMENTATION_REPORT.md`](IMPLEMENTATION_REPORT.md).
