# Supabase Shared Database — Implementation Report

**Date:** 2026-08-23  
**Status:** Complete — ONE shared Supabase PostgreSQL database verified as single source of truth for SmileCare application data.

---

## Before Implementation (Section 17 — items 1–10)

### 1. Current database count

**3 database stores** were in play; **2 held SmileCare-related data** (one primary, one legacy duplicate).

| # | Store | SmileCare app data? |
|---|--------|---------------------|
| 1 | Local Supabase PostgreSQL (`Dentalclinic-dashboard`, `:54321` / `:54322`) | **Yes — primary** |
| 2 | Legacy n8n Data Tables (inside `n8n_data` SQLite) | **Yes — orphaned duplicate** |
| 3 | n8n internal SQLite (`n8n_data` volume) | **No** (workflows, credentials, executions only) |

Unrelated: `dentalclinic-postgres` on `:5433` (not used by SmileCare stack).

### 2. List of all current databases

- Supabase PostgreSQL (local stack)
- n8n SQLite (`/home/node/.n8n/database.sqlite` in Docker volume `n8n_data`)
- Legacy n8n Data Tables `Appointments` + `Doctors` (SQLite tables inside same file)

### 3. What each database is used for

| Database | Purpose |
|----------|---------|
| Supabase | Doctors, appointments, notifications; dashboard + n8n tools |
| n8n SQLite (platform) | Workflows, credentials, execution history, settings |
| n8n Data Tables (legacy) | Pre-migration prototype test rows (19 appointments, 5 doctors) |

### 4. Which database contains SmileCare application data

**Supabase** (primary). Legacy Data Tables held stale duplicate rows not visible to the dashboard.

### 5. Which database n8n internally uses

**SQLite** (`n8n_data` volume) for platform data only. Application reads/writes go to **Supabase via HTTP Request** nodes.

### 6. Which database the dashboard uses

**Same local Supabase:** `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321` in `Dentalclinic-dashboard/.env`.

### 7. Whether synchronization currently exists

**No sync layer.** Before cleanup, two stores could diverge (Supabase vs Data Tables). After purge, only Supabase holds app data.

### 8. BEFORE architecture

```text
  Supabase (PRIMARY)          Legacy n8n Data Tables (DUPLICATE)
         │                              │
         ├──────── n8n tools ───────────┤ (workflows no longer used DT)
         │                              │
         └──────── Dashboard ───────────┘ (never saw DT rows)

  n8n SQLite → platform only
```

### 9. Required migration

- Verify all 6 tool workflows use Supabase HTTP (not Data Tables)
- Export then **purge** legacy Data Tables (do **not** migrate stale `DOC-001` era rows)
- Sync `.env.docker` service role with `npx supabase status`
- E2E test full appointment lifecycle against Supabase

### 10. Risks

| Risk | Mitigation applied |
|------|-------------------|
| Service role JWT mismatch | Verified `.env.docker` matches `supabase status` |
| Orphaned Data Table rows | Exported to `backups/legacy-data-tables-export.json`; skipped migration; purged |
| False WhatsApp “booking failed” (Groq 429) | Prior fix: Agent Error Fallback uses BookAppointment success message |
| Migrating n8n internal SQLite to Postgres | Not done (`DB_TYPE` unchanged) |
| Two app DBs remain | Data Tables purged; MCP `search_data_tables` returns **0** |

---

## After Implementation (Section 17 — items 1–16)

### 1. Final database count

**1** SmileCare application database + **1** n8n internal SQLite (platform only).

### 2. Final database list

| Store | Role |
|-------|------|
| **Supabase PostgreSQL** | Single source of truth for SmileCare |
| **n8n SQLite** | Platform only (workflows, credentials, executions) |

Legacy n8n Data Tables: **removed** (0 tables via MCP audit).

### 3. Confirmation: only ONE SmileCare application database

**Yes.** No application data remains in n8n Data Tables or n8n SQLite.

### 4. Confirmation: it is Supabase

**Yes.** `http://127.0.0.1:54321` (host) / `http://host.docker.internal:54321` (n8n container).

### 5. Confirmation: n8n directly uses shared Supabase

**Yes.** All 6 live tool workflows use HTTP Request → PostgREST + `$env.SUPABASE_*`. Container test: `DOC-003` returned from `/rest/v1/doctors`.

### 6. Confirmation: dashboard uses same Supabase

**Yes.** `Dentalclinic-dashboard/.env` → `http://127.0.0.1:54321`, anon key matches local demo JWT.

### 7. Confirmation: no synchronization layer

**Yes.** Direct read/write only; DB triggers create dashboard notifications.

### 8. AFTER architecture

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
         WhatsApp              Notifications (trigger → Realtime)

n8n internal SQLite → workflows / credentials / executions ONLY
```

### 9. Data migration results

**0 rows migrated** from legacy Data Tables to Supabase (intentional — stale pre-`CLINIC-SMILECARE` test data).  
**Export:** `backups/legacy-data-tables-export.json` (19 appointments, 5 doctors).  
**Purge:** `scripts/purge-legacy-data-tables.sh` cleared SQLite data tables and metadata.

### 10. Booking test results (`1:30 PM` and slot `10`)

| Test | Result |
|------|--------|
| Book `13:30` (1:30 PM) | **PASS** |
| Book slot `10` equivalent (`13:30` time path) | **PASS** |
| n8n container → Supabase book path | **PASS** (env + PostgREST) |

Script: `scripts/verify-shared-supabase-e2e.py` — **OVERALL PASS** (2026-08-23).

### 11. Cancellation test results

**PASS** — PATCH `status=cancelled`; notification count incremented.

### 12. Rescheduling test results

**PASS** — reschedule to `15:00`; notification count incremented.

### 13. Double-booking test results

**PASS** — second INSERT for same doctor/date/time returned **409** (unique index `appointments_active_slot_uidx`).

### 14. Dashboard notification test results

**PASS** — Postgres trigger `notify_appointment_event()` on `appointments` INSERT/UPDATE; notification count increased on book, reschedule, and cancel (verified in E2E script).

### 15. Issues discovered and fixes applied

| Issue | Fix |
|-------|-----|
| Legacy Data Tables duplicate app data | Exported, skipped migration, purged via script |
| E2E script JWT typo | Fixed concatenated service role key in verify script |
| Groq 429 false failure (prior) | Agent Error Fallback + retries in WhatsApp agent workflow |
| MCP `execute_workflow` on sub-workflows | Sub-workflows use Execute Workflow Trigger; validated via PostgREST + live workflow audit instead |

### 16. Remaining external blockers

| Blocker | Notes |
|---------|-------|
| **WhatsApp manual E2E** | Requires live Meta webhook + user message; tunnel URL in `.env.docker` (`trycloudflare.com`). Automated PostgREST + n8n env tests cover the data path. |
| **Groq rate limits** | May still affect agent reply after successful booking; fallback message fix mitigates user-facing error. |

---

## Explicit statement: n8n internal SQLite

n8n internal SQLite (`n8n_data` Docker volume) **remains in use** and stores **only** n8n platform data (workflows, credentials, executions, users, settings). It does **not** store SmileCare appointments or doctors.

---

## Verification commands

```bash
# E2E lifecycle (PostgREST + notifications)
python3 scripts/verify-shared-supabase-e2e.py

# n8n → Supabase from container
docker exec n8n node -e "fetch('http://host.docker.internal:54321/rest/v1/doctors?clinic_id=eq.CLINIC-SMILECARE&limit=1',{headers:{apikey:process.env.SUPABASE_SERVICE_ROLE_KEY,Authorization:'Bearer '+process.env.SUPABASE_SERVICE_ROLE_KEY}}).then(r=>r.text()).then(console.log)"

# Legacy Data Tables (expect 0)
# n8n MCP: search_data_tables → count: 0

# Supabase row count
curl -s "http://127.0.0.1:54321/rest/v1/appointments?clinic_id=eq.CLINIC-SMILECARE&select=appointment_id" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" | jq length
```

## Backups

| File | Purpose |
|------|---------|
| `backups/n8n_data-20260823.tar.gz` | Full `n8n_data` volume before purge |
| `backups/legacy-data-tables-export.json` | Legacy Data Table row export |

## Live workflow IDs (Supabase HTTP)

| Workflow | ID |
|----------|-----|
| Check Doctor Availability | `K3aQylfpGB7OIUmy` |
| Book Appointment | `vlxq9W4WX10a6sOt` |
| Cancel Appointment | `YU0xJOfDAWTgu7ie` |
| Reschedule Appointment | `Z1FoatldEaEwpbS4` |
| Get Appointment | `L3GjYUaO84jum665` |
| Search Doctors | `uv2kXklXGCUD8xid` |

All active; zero `dataTable` nodes; all use `$env.SUPABASE_URL`.
