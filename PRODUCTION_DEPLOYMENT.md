# SmileCare — Production Deployment Guide

Stand up the **entire** SmileCare system in production: the n8n WhatsApp agent on an Oracle
Cloud VM, the Next.js clinic-desk web portal on Vercel, and the shared Supabase Postgres
database — plus the Meta/WhatsApp wiring that connects them.

- **Fast path (§D):** ~5–20 minutes if you already have the accounts, credentials, source
  code, SSH access, and the `n8n_data` volume archive listed in §B.
- **From absolute scratch:** do §F first (provision the Oracle VM, DuckDNS subdomain,
  Supabase project, Meta app), then §D.
- This guide is self-contained. `../Dentalclinic-dashboard/DEPLOYMENT.md` and
  `../Dentalclinic-dashboard/DEPLOYMENT_TROUBLESHOOTING.md` carry extra background only.
- Companion: **`PRODUCTION_UPDATE.md`** — how to push later changes safely.

---

## A. System architecture

```
  Patient's WhatsApp
        │  (Meta sends inbound messages to the webhook)
        ▼
  Meta WhatsApp Cloud API  ──────────────────────────────┐
        │  POST https://smilecare-n8n.duckdns.org         │ replies sent back
        │       /webhook/e60f653f-…-f3cca62cad2c/webhook   │ via Graph API
        ▼                                                 │
  Oracle Cloud Always-Free VM (Ubuntu 24.04 arm64)        │
  ┌──────────────────────────────────────────────┐        │
  │  caddy:2      :80/:443  Let's Encrypt TLS      │        │
  │      │  reverse_proxy n8n:5678                 │        │
  │  n8n 2.34.6  127.0.0.1:5678  (loopback only)   │────────┘
  │      • SQLite in Docker volume  n8n_data       │
  │      • 9 workflows: 1 agent (incl. voice notes)│
  │        + 7 tool sub-workflows + 1 error handler│
  └───────┬───────────────────────┬───────────────┘
          │ LLM + Whisper         │ PostgREST (service_role key)
          ▼                       ▼
       Groq API          Supabase Postgres  ── single source of truth
                          (project iipilbnsfaiizzlzzfcv)
                                  │  Realtime (WSS, postgres_changes)
                                  ▼
                   Next.js clinic desk on Vercel
                   https://dentalclinic-dashboard.vercel.app
                   (browser uses anon key + RLS + Supabase Auth cookies)
```

| Component | Platform | URL / address | Talks to |
| --- | --- | --- | --- |
| WhatsApp agent (n8n) | Oracle Always-Free VM, Docker | `https://smilecare-n8n.duckdns.org/` (public), `127.0.0.1:5678` (internal) | Meta Cloud API, Groq, Supabase (PostgREST) |
| TLS reverse proxy | Caddy on the same VM | ports 80/443 | proxies to `n8n:5678` |
| Web portal | Vercel (Hobby) | `https://dentalclinic-dashboard.vercel.app` | Supabase (anon + Realtime) |
| Database / Auth / Realtime | Supabase Cloud (Free) | `https://iipilbnsfaiizzlzzfcv.supabase.co` | — |
| LLM + speech-to-text | Groq | `api.groq.com` | — |

**Key facts**

- n8n's internal store is **SQLite inside the Docker volume `n8n_data`** (`/home/node/.n8n`).
  It holds workflows, credentials, and execution history — **no appointment data**.
- **Supabase Postgres is the single source of truth** for appointments/doctors/clinics.
  Both n8n and the web portal read/write it directly; there is no sync layer.
- The web portal's `src/` needs **no code changes** to deploy — it is fully env-driven.
- Every n8n query is pinned to `clinic_id=eq.CLINIC-SMILECARE`.
- n8n is migrated by **copying the `n8n_data` volume**, never by re-importing workflow JSON
  (the agent hard-codes live sub-workflow IDs that a fresh import would renumber).

---

## B. Prerequisites

**Accounts (already created):**

- Oracle Cloud — an Always-Free VM already running and reachable over SSH (see §F to create one).
- Supabase — a Free project already created (ref `iipilbnsfaiizzlzzfcv`, or your own).
- Vercel — Hobby account.
- GitHub — both repos pushed: `ahtasham067/Dentalclinic-dashboard` and this `n8n-project`.
- DuckDNS — subdomain `smilecare-n8n` created (or your own).
- Meta for Developers — an app with the **WhatsApp** product, a WhatsApp Business Account
  (WABA), and a phone number (test or verified).
- Groq — an API key.

**On your laptop:**

- Both repos cloned side by side:
  `/media/ahtasham/Partion C1/projects/n8n-project` and `.../Dentalclinic-dashboard`.
- Docker + Docker Compose.
- Node ≥ 20.9 and `npx`.
- The current n8n volume archive `n8n-project/backups/n8n_data-migrate.tar.gz` — or a
  working local n8n container to export it from (step D-2).

**Access:**

- The SSH **private key** for `ubuntu@<VM_PUBLIC_IP>`. In this project it lives at
  `/media/ahtasham/Partion C1/projects/deployment-dental-care/ssh-key-26.key`
  (also `doctor-appointment-system-new.key`). Lock it down before use:
  ```bash
  chmod 600 "/media/ahtasham/Partion C1/projects/deployment-dental-care/ssh-key-26.key"
  ```

---

## C. Fill-in values

Non-secret identifiers for this deployment are pre-filled. Fill the blank column with your
secrets before starting; keep them out of git.

| Item | Value |
| --- | --- |
| n8n production base URL | `https://smilecare-n8n.duckdns.org/` (trailing slash required) |
| n8n DuckDNS host | `smilecare-n8n.duckdns.org` |
| n8n production webhook path | `/webhook/e60f653f-a2f6-4686-909b-f3cca62cad2c/webhook` |
| n8n full Meta callback URL | `https://smilecare-n8n.duckdns.org/webhook/e60f653f-a2f6-4686-909b-f3cca62cad2c/webhook` |
| Meta webhook **Verify Token** | `4d182743-5c30-44b2-8bb7-b346135a7e70` (the WhatsApp Trigger node id) |
| n8n Docker image (pinned) | `docker.n8n.io/n8nio/n8n:2.34.6` |
| VM login | `ubuntu@<VM_PUBLIC_IP>` |
| VM server directory | `~/smilecare-n8n` (`/home/ubuntu/smilecare-n8n`) |
| n8n Docker volume name | `n8n_data` (NOT `n8n-project_n8n_data`) |
| Web portal URL | `https://dentalclinic-dashboard.vercel.app` |
| Web portal repo | `ahtasham067/Dentalclinic-dashboard`, branch `main` |
| Supabase project ref | `iipilbnsfaiizzlzzfcv` |
| Supabase URL | `https://iipilbnsfaiizzlzzfcv.supabase.co` |
| Clinic / default doctor | `CLINIC-SMILECARE` / `DOC-003` "Dr. Bilal Hussain" |
| Timezone | `Asia/Karachi` |
| WhatsApp sender Phone Number ID | Env `WHATSAPP_PHONE_NUMBER_ID` + `WHATSAPP_ALLOWED_PHONE_NUMBER_IDS` (REAL profile — the clinic number only). Replies use the inbound number automatically — see D-6d and `WHATSAPP_REAL_NUMBER_SETUP.md` |

| Secret / per-environment value | Fill in |
| --- | --- |
| `<VM_PUBLIC_IP>` | |
| Supabase `service_role` key (cloud) | |
| Supabase `anon` key (cloud) | |
| Supabase DB password | |
| `WHATSAPP_ACCESS_TOKEN` (Meta **System User** token generated **for the production app**, expiry Never) | |
| `WHATSAPP_PHONE_NUMBER_ID` / `WHATSAPP_ALLOWED_PHONE_NUMBER_IDS` (real number's Phone Number ID) | |
| `WHATSAPP_CLIENT_SECRET` / Meta **App Secret** | |
| `WHATSAPP_CLIENT_ID` / Meta **App ID** (production: `1755561068820381` "Appointment Syatem"; local dev keeps `1452204086838529`) | |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` / WABA ID (the real number's WABA; `1628386515555176` is the Meta *test* WABA) | |
| Groq API key | |
| SMTP user / password (optional — error-alert emails) | |

---

## D. Deploy — fast path

Do the steps in order. Each step lists the commands, the expected result, and why.

### D-1. Supabase: schema, Realtime, Auth, (optional) seed

**Why:** the database must have the full schema, the Realtime publication, and the Auth URLs
before the portal and n8n can use it.

```bash
cd "/media/ahtasham/Partion C1/projects/Dentalclinic-dashboard"
npx supabase login
npx supabase link --project-ref iipilbnsfaiizzlzzfcv
npx supabase db push        # applies supabase/migrations/*.sql in filename order
```

Migrations applied (order matters):

1. `20260821070000_init_schema_rls.sql` — extensions, enums, tables `clinics` / `staff` /
   `doctors` / `appointments`, `current_clinic_id()` + `current_staff_role()`, RLS + tenant
   policies, adds `appointments` to `supabase_realtime`.
2. `20260821070100_grants.sql` — schema/role grants; `service_role` gets full access.
3. `20260821120000_notifications.sql` — `appointments` `REPLICA IDENTITY FULL`; the partial
   unique index `appointments_active_slot_uidx` (double-booking guard); `notifications` table
   + trigger `notify_appointment_event()`; adds `notifications` to Realtime.
4. `20260821140000_notification_copy_format.sql` — 12-hour time + notification body formatters.
5. `20260824120000_smilecare_features.sql` — `front_desk`→`sub_user` rename; `clinic_settings`
   + `doctor_blocks` tables; `staff.disabled`; admin-gated write policies; RPCs
   `get_clinic_runtime_config`, `get_available_slots`, `validate_appointment_slot`,
   `sync_doctor_name_on_appointments`.

> No CLI? Open Supabase → **SQL Editor** and paste the five files, one at a time, in the
> order above. Do **not** re-add `appointments` / `notifications` under Database →
> Replication — the migrations already do it ("already member of publication" error).

**Verify (SQL Editor):**

```sql
select tablename from pg_publication_tables where pubname = 'supabase_realtime';
-- expect: appointments, notifications

select tgname   from pg_trigger  where tgname   = 'appointments_notify_event';
select indexname from pg_indexes where indexname = 'appointments_active_slot_uidx';
-- each returns exactly one row
```

**Seed — only if this project has no real data yet.** The seed **deletes every row** in
`notifications`, `appointments`, `doctor_blocks`, `clinic_settings`, `doctors`, `staff`,
`clinics` (all clinics) before inserting demo data. Skip this entirely on a project that
already holds live bookings.

```bash
# .env.cloud must contain the cloud URL + anon + service_role keys
cat > .env.cloud <<'EOF'
NEXT_PUBLIC_SUPABASE_URL=https://iipilbnsfaiizzlzzfcv.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<cloud-anon-key>
SUPABASE_SERVICE_ROLE_KEY=<cloud-service-role-key>
NEXT_PUBLIC_APP_URL=https://dentalclinic-dashboard.vercel.app
CLINIC_TIMEZONE=Asia/Karachi
EOF

ALLOW_SUPABASE_SEED=1 npx tsx --env-file=.env.cloud scripts/seed-supabase.ts
```

The seed creates `CLINIC-SMILECARE` + `DOC-003` (both required by n8n's "Dental Clinic
Config" node) and these logins:

| Email | Password | Role |
| --- | --- | --- |
| `admin@smilecare.local` | `admin123` | admin |
| `desk@smilecare.local` | `desk123` | sub_user |
| `admin@otherclinic.local` | `other123` | other clinic (RLS-isolation fixture) |

If you **skip the seed** on a fresh project, you must create at least the
`CLINIC-SMILECARE` clinic row, the `DOC-003` doctor row, its `clinic_settings` row
(`whatsapp_default_doctor_id = DOC-003`), and one admin staff user by hand.

**Auth URLs** — Supabase → **Authentication → URL Configuration**:

- Site URL: `https://dentalclinic-dashboard.vercel.app`
- Redirect URLs: add `https://dentalclinic-dashboard.vercel.app/**`

(`supabase/config.toml` is local-CLI only; it does not push Auth settings to the cloud.)

**Collect the API keys** — Supabase → **Settings → API**: Project URL, `anon` `public` key,
`service_role` `secret` key. You need all three below.

---

### D-2. Export the n8n volume from the laptop (skip if you already have the archive)

**Why:** the VM's n8n must be a byte-for-byte copy of your working instance so the
hard-coded sub-workflow IDs, the encryption key, and all encrypted credentials come across.

```bash
cd "/media/ahtasham/Partion C1/projects/n8n-project"

# Confirm the live volume name — must be n8n_data, not n8n-project_n8n_data
docker inspect n8n --format '{{range .Mounts}}{{.Name}} {{end}}'

docker compose stop
mkdir -p backups
docker run --rm -v n8n_data:/data -v "$PWD/backups":/backup alpine \
  tar czf /backup/n8n_data-migrate.tar.gz -C /data .
docker compose start        # bring local n8n back if you want
ls -lh backups/n8n_data-migrate.tar.gz    # expect ~2 MB+
```

> `deploy/migrate-n8n-volume.sh export` does the same with a safety check that refuses to
> archive the wrong volume. `VM_HOST=ubuntu@<VM_PUBLIC_IP> SSH_KEY=<key> ./deploy/migrate-n8n-volume.sh all`
> exports **and** uploads in one shot.

---

### D-3. Ship n8n to the Oracle VM

**Why:** put the prod compose files on the VM, restore the volume under the exact name
`n8n_data`, and write the production `.env`.

```bash
cd "/media/ahtasham/Partion C1/projects/n8n-project"
KEY="/media/ahtasham/Partion C1/projects/deployment-dental-care/ssh-key-26.key"
VM="ubuntu@<VM_PUBLIC_IP>"

scp -i "$KEY" -r deploy "$VM:~/smilecare-n8n"
scp -i "$KEY" -r scripts "$VM:~/smilecare-n8n/scripts"   # for the diagnostics in D-6
scp -i "$KEY" backups/n8n_data-migrate.tar.gz "$VM:~/"
ssh -i "$KEY" "$VM"
```

On the VM:

```bash
docker volume create n8n_data
docker run --rm -v n8n_data:/data -v ~/:/backup alpine \
  tar xzf /backup/n8n_data-migrate.tar.gz -C /data
# equivalent: ~/smilecare-n8n/migrate-n8n-volume.sh restore ~/n8n_data-migrate.tar.gz

cd ~/smilecare-n8n
cp .env.production.example .env
chmod 600 .env
nano .env
```

Set in `~/smilecare-n8n/.env`:

```ini
N8N_HOST=smilecare-n8n.duckdns.org
N8N_PROTOCOL=https
N8N_SECURE_COOKIE=true
WEBHOOK_URL=https://smilecare-n8n.duckdns.org/
N8N_EDITOR_BASE_URL=https://smilecare-n8n.duckdns.org/
N8N_PROXY_HOPS=1
N8N_BLOCK_ENV_ACCESS_IN_NODE=false

SUPABASE_URL=https://iipilbnsfaiizzlzzfcv.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<cloud-service-role-key>

TZ=Asia/Karachi
CLINIC_TIMEZONE=Asia/Karachi

# WhatsApp sender profile (REAL) — required; read by the workflows via $env
WHATSAPP_PHONE_NUMBER_ID=<real-phone-number-id>
WHATSAPP_ALLOWED_PHONE_NUMBER_IDS=<real-phone-number-id>

# Optional — only if you will re-sync WhatsApp creds with apply-whatsapp-auth.py on the VM
# WHATSAPP_ACCESS_TOKEN=<system-user-token-for-production-app>
# WHATSAPP_BUSINESS_ACCOUNT_ID=<real-waba-id>
# WHATSAPP_CLIENT_ID=1755561068820381
# WHATSAPP_CLIENT_SECRET=<production-meta-app-secret>
```

**Do NOT add** `N8N_ENCRYPTION_KEY` (it is inside the volume; a new one makes every
credential undecryptable), `DB_TYPE=postgresdb`, or `OPENAI_API_KEY` (the agent uses Groq).

Start the stack:

```bash
cd ~/smilecare-n8n
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps      # n8n + caddy both "running"
curl -sf http://127.0.0.1:5678/healthz && echo OK
```

Expected: `{"status":"ok"}` then `OK`.

---

### D-4. DNS + TLS

**Why:** Meta will only call a stable HTTPS URL with a valid certificate.

- DuckDNS → set the `smilecare-n8n` subdomain's IP to `<VM_PUBLIC_IP>`.
- Oracle **Security List** for the VM's subnet — Ingress: `0.0.0.0/0` TCP **80** and **443**;
  your IP TCP **22**. Never expose 5678.
- On the VM, open 80/443 in the host firewall (Ubuntu images drop them even when the
  Security List is open):

  ```bash
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80  -j ACCEPT
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
  sudo apt-get update && sudo apt-get install -y iptables-persistent
  sudo netfilter-persistent save
  ```

**Verify (from the laptop):**

```bash
dig +short smilecare-n8n.duckdns.org          # must print <VM_PUBLIC_IP>
sleep 60                                        # let Caddy get the Let's Encrypt cert
curl -I https://smilecare-n8n.duckdns.org/healthz   # HTTP/2 200
```

If the cert fails: `docker logs caddy` on the VM; the usual cause is 80/443 unreachable
(Security List or iptables) or DNS not yet pointing at the VM.

---

### D-5. Activate the agent workflow

**Why:** n8n only serves the production webhook path — and re-registers the Meta callback —
when the workflow is Active.

1. Open `https://smilecare-n8n.duckdns.org` and log in with the **owner account that came
   with the volume** (same credentials as your local n8n).
2. Confirm **9 workflows** are present and open one credential of each type to confirm they
   decrypt: **Groq account**, **WhatsApp OAuth account**, **WhatsApp account**,
   **SMTP account**.
3. Open **WhatsApp AI Appointment Booking Agent** → toggle **Active** (top-right).
4. Confirm the production webhook still resolves:

   ```bash
   # on the VM
   curl -s -o /dev/null -w '%{http_code}\n' -X POST \
     http://127.0.0.1:5678/webhook/e60f653f-a2f6-4686-909b-f3cca62cad2c/webhook -d '{}'
   # 200 = path registered (unsigned body is dropped, that's fine). 404 = not active.
   ```

---

### D-6. Meta / WhatsApp wiring + verification

**Why:** confirm the token works, the callback points at DuckDNS, `messages` is subscribed,
and the sender Phone Number ID in the env is current.

**a) Token** (from the laptop or the VM — this one only talks to the Graph API):

```bash
cd "/media/ahtasham/Partion C1/projects/n8n-project"   # or ~/smilecare-n8n on the VM
WHATSAPP_ACCESS_TOKEN='<system-user-token>' \
WHATSAPP_PHONE_NUMBER_ID='<real-phone-number-id>' \
WHATSAPP_BUSINESS_ACCOUNT_ID='<real-waba-id>' \
python3 scripts/verify-whatsapp-token.py --no-send
```

Expect: token valid, `type` **not** `USER` (use a Business **System User** token, expiry
Never), sender `status: CONNECTED`, and no WABA health errors. Drop `--no-send` (and set
`WHATSAPP_TEST_RECIPIENT` to a patient-side number that messaged you in the last 24 h) to
also send a live test message. If it prints error `131005`, mint a System User token
(Meta Business Settings → Users → System users → Generate token → select the WABA →
permissions `whatsapp_business_messaging` + `whatsapp_business_management` → Expiration
**Never**), then update the **WhatsApp account** credential in n8n (or set `WHATSAPP_*` in
`~/smilecare-n8n/.env` and run `python3 scripts/apply-whatsapp-auth.py` on the VM).

**b) Full webhook chain** — run this **on the VM** (`cd ~/smilecare-n8n`), because stages 1–4
probe n8n on `http://127.0.0.1:5678`:

```bash
export APP_ID='<meta-app-id>'
export APP_SECRET='<meta-app-secret>'
export WABA_ID='<waba-id>'
export ACCESS_TOKEN='<system-user-token>'
export PHONE_NUMBER_ID='<real-phone-number-id>'
export PUBLIC_URL='https://smilecare-n8n.duckdns.org'
python3 scripts/diagnose-whatsapp-webhook.py
```

(From the laptop it still works for the Meta-side stages if you also
`export N8N_BASE='https://smilecare-n8n.duckdns.org'`.)

It checks, in order — **fix the earliest FAIL, then re-run**:

1. `PUBLIC_URL/healthz` reachable (DNS + TLS + firewall + Caddy).
2. n8n `/healthz` on loopback.
3. `POST /webhook/e60f653f-…/webhook` ≠ 404 → workflow is Active.
4. GET verify handshake echoes `hub.challenge` when `hub.verify_token` =
   `4d182743-5c30-44b2-8bb7-b346135a7e70` → verify token confirmed.
5. Signed `X-Hub-Signature-256` POST → n8n accepts it → the App Secret stored in the
   **WhatsApp OAuth account** credential matches Meta. (Mismatch = 200 but **no execution**.)
6. Meta app subscription includes `whatsapp_business_account`, is `active`, has field
   `messages`, and `callback_url` equals
   `https://smilecare-n8n.duckdns.org/webhook/e60f653f-a2f6-4686-909b-f3cca62cad2c/webhook`
   (and is not a `trycloudflare.com` tunnel).
7. The WABA appears in `/{WABA_ID}/subscribed_apps` and exposes a `phone_number_id`.

**c) In the Meta App dashboard** (developers.facebook.com → your app → WhatsApp →
Configuration): the callback URL is normally written by n8n on activation. If you must set it
by hand, use the URL above with Verify Token `4d182743-5c30-44b2-8bb7-b346135a7e70`, then
subscribe the **`messages`** field.

**d) Phone number ID — env, not the node.** **Send WhatsApp Reply** sends from the number
that received the message (`metadata.phone_number_id`, captured by **Normalize WhatsApp
Message**), falling back to `WHATSAPP_PHONE_NUMBER_ID`. **Send WhatsApp Notification** uses
`WHATSAPP_PHONE_NUMBER_ID`. The **Allowed Business Number?** node drops messages to any
number not in `WHATSAPP_ALLOWED_PHONE_NUMBER_IDS`. So a number change is an env change:
set both vars in `~/smilecare-n8n/.env` to the real Phone Number ID (Meta → WhatsApp → API
Setup, or the diagnostic output), then `docker compose -f docker-compose.prod.yml up -d`.
`diagnose-whatsapp-webhook.py` stage 7 fails if `PHONE_NUMBER_ID` is not on your WABA.

> **Superseded (2026-10-21):** production moves to its own app `1755561068820381` and the
> clinic's real number; local dev keeps app `1452204086838529` + the test number. See
> `WHATSAPP_REAL_NUMBER_SETUP.md`. Historical note:
>
> **Drift resolved (2026-09-13):** `.env.meta`, `.env`/`.env.docker`, and the workflow JSON
> now all agree on one Meta app — `META_APP_ID` / `WHATSAPP_CLIENT_ID=1452204086838529`,
> App Secret `<meta-app-secret>` (never write the real value in docs), `WHATSAPP_WABA_ID` /
> `WHATSAPP_BUSINESS_ACCOUNT_ID=1628386515555176`, `WHATSAPP_PHONE_NUMBER_ID=1296266210241103`.
> If they ever diverge again, the diagnostic scripts are the arbiter — run them and follow
> the earliest FAIL.

---

### D-7. Deploy the web portal to Vercel

**Why:** the clinic desk is a standard Next.js app; Vercel builds and hosts it, and
redeploys automatically on every push to `main`.

1. Vercel → **Add New → Project** → import `ahtasham067/Dentalclinic-dashboard`.
2. Framework preset **Next.js** (auto). Build `next build`, Install `npm install`, Output default.
3. **Settings → General → Node.js Version → 22** (the repo pins nothing; the app needs ≥ 20.9).
4. **Settings → Environment Variables** (add for **Production** and **Preview**):

   | Name | Value | Notes |
   | --- | --- | --- |
   | `NEXT_PUBLIC_SUPABASE_URL` | `https://iipilbnsfaiizzlzzfcv.supabase.co` | build-time baked |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `<cloud-anon-key>` | build-time baked |
   | `SUPABASE_SERVICE_ROLE_KEY` | `<cloud-service-role-key>` | **no `NEXT_PUBLIC_` prefix** — server only |
   | `CLINIC_TIMEZONE` | `Asia/Karachi` | |
   | `NEXT_PUBLIC_APP_URL` | `https://dentalclinic-dashboard.vercel.app` | optional today |

5. **Deploy.** Then open `https://dentalclinic-dashboard.vercel.app/login` and sign in with a
   seeded admin (`admin@smilecare.local` / `admin123`).

**How the portal connects to the backend:** the browser and server components use the
Supabase **anon** key and are constrained by RLS + `current_clinic_id()`; three staff
Auth-admin API routes use the `service_role` key server-side; the browser subscribes to
Supabase **Realtime** over WSS directly (Vercel is not in that path). There is no separate
API service and the portal never calls n8n.

---

## E. End-to-end verification

Run all of these after D-1…D-7.

```bash
# 1. n8n public health
curl -I https://smilecare-n8n.duckdns.org/healthz            # 200

# 2. Portal loads and auth works
#    open https://dentalclinic-dashboard.vercel.app/login  -> sign in as admin@smilecare.local

# 3. RLS tenant isolation (only meaningful if you seeded)
#    In the portal as a SmileCare user, confirm the "Secret Patient" row
#    (APT-OTHER0001, CLINIC-OTHER) is NOT visible anywhere.

# 4. DB write -> Realtime. Insert one appointment as service_role and watch the desk.
curl -sS -X POST "https://iipilbnsfaiizzlzzfcv.supabase.co/rest/v1/appointments" \
  -H "apikey: <cloud-service-role-key>" \
  -H "Authorization: Bearer <cloud-service-role-key>" \
  -H "Content-Type: application/json" -H "Prefer: return=representation" \
  -d '{"appointment_id":"APT-DEPLOYCHECK","clinic_id":"CLINIC-SMILECARE",
       "patient_name":"Deploy Check","phone_number":"+923000000000",
       "doctor_id":"DOC-003","doctor_name":"Dr. Bilal Hussain",
       "appointment_date":"2099-01-01","appointment_time":"10:00","status":"booked"}'
#    Expect 201 and a toast + bell on the open dashboard WITHOUT refreshing.
#    Clean up:
curl -sS -X PATCH "https://iipilbnsfaiizzlzzfcv.supabase.co/rest/v1/appointments?appointment_id=eq.APT-DEPLOYCHECK" \
  -H "apikey: <cloud-service-role-key>" -H "Authorization: Bearer <cloud-service-role-key>" \
  -H "Content-Type: application/json" -d '{"status":"cancelled"}'

# 5. WhatsApp round trip
#    From a Meta-verified phone, send "hi" to the business number.
#    n8n UI -> Executions: a green run appears within seconds.
#    You receive an AI reply on WhatsApp.

# 6. n8n offline unit tests
cd "/media/ahtasham/Partion C1/projects/n8n-project" && npm test    # test:time + test:language
```

Optional deeper checks (`scripts/verify-shared-supabase-e2e.py`,
`scripts/test-appointment-lifecycle.py`, `node scripts/test-availability-supabase.js`)
default to the **local** Supabase demo key and `127.0.0.1:54321`. To point them at cloud,
set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the environment — and only run them
against a scratch project, because they create and cancel real rows.

---

## F. Provisioning reference (true from-scratch)

Do this once, before §D, if the infrastructure doesn't exist yet.

**Oracle Cloud Always-Free VM**

- oracle.com/cloud/free → Start for free. A real card is required for identity; Always-Free
  shapes are not charged. **The home region is permanent** for Always-Free compute.
- Compute → Instances → Create instance. Image **Ubuntu 24.04 (aarch64)**. Shape
  **VM.Standard.A1.Flex — 2 OCPU / 12 GB** (Always-Free ceiling). If "Out of host capacity":
  retry, change availability domain, or fall back to AMD `VM.Standard.E2.1.Micro` (1 GB) plus
  a swap file.
- Assign a public IPv4. Paste your SSH **public** key at creation.
- Networking → VCN → Subnet → Security List → Ingress: `0.0.0.0/0` TCP 80 + 443; your IP
  TCP 22.
- SSH in and install Docker:

  ```bash
  ssh -i <private-key> ubuntu@<VM_PUBLIC_IP>
  # host firewall (see D-4) — open 80/443 and persist
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker ubuntu
  # log out, SSH back in
  docker run --rm hello-world && docker compose version
  ```

**DuckDNS**

- duckdns.org → sign in → create subdomain `smilecare-n8n` → set current IP to the VM's
  public IPv4. One A record; no CNAME, no proxy.

**Supabase Free project**

- supabase.com → New project → Free plan → region nearest users (e.g. `ap-south-1` Mumbai).
- Set a strong DB password (needed for `pg_dump`/CLI, not the app). Wait until healthy.
- Settings → API gives Project URL, `anon` key, `service_role` key.
- Settings → General gives the project ref (used in `supabase link`).

**Meta / WhatsApp**

- developers.facebook.com → create an app → add the **WhatsApp** product.
- You get a test phone number and a temporary token; for anything beyond a quick test, mint a
  **System User** token (Business Settings → Users → System users → Generate token → select
  the WABA → permissions `whatsapp_business_messaging` + `whatsapp_business_management` →
  Expiration **Never**).
- Note the **App ID**, **App Secret**, **WABA ID**, and **Phone Number ID**.
- Add up to 5 verified test-recipient numbers if using the free test number.

**Groq**

- console.groq.com → API Keys → create a key. It is set only in the n8n **Groq account**
  credential (there is no Groq env var anywhere in this project).

---

## G. Credential & configuration inventory

| Name | Lives in | Secret? | How to set |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Vercel env (Prod+Preview) | no | Vercel dashboard; redeploy after change |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Vercel env | no (RLS protects data) | Vercel dashboard; redeploy after change |
| `SUPABASE_SERVICE_ROLE_KEY` (portal) | Vercel env — **server only, no `NEXT_PUBLIC_`** | **yes** | Vercel dashboard; redeploy after change |
| `CLINIC_TIMEZONE` (portal) | Vercel env | no | Vercel dashboard |
| `SUPABASE_URL` (n8n) | `~/smilecare-n8n/.env` on the VM | no | edit file, `docker compose -f docker-compose.prod.yml up -d` |
| `SUPABASE_SERVICE_ROLE_KEY` (n8n) | `~/smilecare-n8n/.env` on the VM | **yes** | edit file, recreate container |
| `WEBHOOK_URL`, `N8N_EDITOR_BASE_URL`, `N8N_HOST`, `N8N_PROTOCOL`, `N8N_SECURE_COOKIE`, `N8N_PROXY_HOPS` | `~/smilecare-n8n/.env` | no | edit file, recreate container |
| `N8N_BLOCK_ENV_ACCESS_IN_NODE` | `~/smilecare-n8n/.env` | no | **must be `false`** or `$env.*` fails in nodes |
| `TZ`, `CLINIC_TIMEZONE` (n8n) | `~/smilecare-n8n/.env` | no | edit file, recreate container |
| `N8N_ENCRYPTION_KEY` | inside the `n8n_data` volume (`/home/node/.n8n/config`) | **yes** | **never set it manually** — it travels with the volume |
| WhatsApp API token + WABA ID | n8n credential **WhatsApp account** (`whatsAppApi`), inside the volume | **yes** | n8n UI, or `scripts/apply-whatsapp-auth.py` on the VM |
| Meta App ID + App Secret | n8n credential **WhatsApp OAuth account** (`whatsAppTriggerApi`), inside the volume | **yes** | n8n UI, or `scripts/apply-whatsapp-auth.py` |
| Groq API key | n8n credential **Groq account** (`groqApi`), inside the volume | **yes** | **n8n UI only** — no env var exists |
| SMTP user/password | n8n credential **SMTP account** (`smtp`), inside the volume | **yes** | n8n UI, or `apply-whatsapp-auth.py`/`build-credentials-overwrite.py` |
| Supabase Auth Site URL / Redirect URLs | Supabase console → Authentication → URL Configuration | no | Supabase dashboard |
| DuckDNS subdomain → IP | duckdns.org | no | DuckDNS dashboard |

`NEXT_PUBLIC_*` values are compiled into the browser bundle at build time — **changing one
requires a Vercel redeploy**, not just saving the variable.

---

## H. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `curl /healthz` works on the VM (`127.0.0.1:5678`) but not on `https://…duckdns.org` | DNS not pointing at the VM, Oracle Security List missing 80/443, host iptables dropping 80/443, or Caddy still fetching the cert | `dig +short …duckdns.org`; check Security List; re-run the iptables block in D-4; `docker logs caddy` |
| Meta GET verify / POST returns **404** | Workflow not **Active**, or the VM's `webhookId` differs | Activate **WhatsApp AI Appointment Booking Agent**; confirm the path is `/webhook/e60f653f-…/webhook` |
| Meta gets **200** but n8n shows **no execution** | App Secret in the **WhatsApp OAuth account** credential ≠ the Meta app's App Secret | Re-save that credential with the correct App Secret; re-run `diagnose-whatsapp-webhook.py` stage 5 |
| Inbound works but replies fail | Token can't send for that number (WABA not assigned to the System User), number not registered, or 24 h window closed (`131047`) | `verify-whatsapp-token.py --no-send`; check n8n **Send WhatsApp Reply** error; see `WHATSAPP_REAL_NUMBER_SETUP.md` §10 |
| Inbound reaches n8n but **no reply and no error** | Number not in `WHATSAPP_ALLOWED_PHONE_NUMBER_IDS` (guard dropped it) | Execution stops at **Allowed Business Number?** — fix the env var, recreate the container |
| VM n8n has **no workflows / empty** | Restored the orphan `n8n-project_n8n_data` instead of `n8n_data` | Recreate the volume from the correct archive under the name `n8n_data` |
| Credentials won't decrypt on the VM | `N8N_ENCRYPTION_KEY` was set in `.env`, or wrong volume restored | Remove `N8N_ENCRYPTION_KEY`; restore the real `n8n_data` archive; recreate the container |
| n8n container crash-loops with a DB/migration error | Image is `:latest` (or newer than `2.34.6`) against a `2.34.6` volume — SQLite migrated irreversibly | Restore the volume from backup; pin `docker.n8n.io/n8nio/n8n:2.34.6` |
| `$env.SUPABASE_URL` is undefined in HTTP Request / Code nodes | `N8N_BLOCK_ENV_ACCESS_IN_NODE` not `false` | Set it to `false` in `~/smilecare-n8n/.env`; `docker compose -f docker-compose.prod.yml up -d` |
| Vercel build fails | Node < 20.9 | Settings → General → Node.js Version → 22; redeploy |
| Portal loads but shows no data / auth loops | Missing/incorrect `NEXT_PUBLIC_SUPABASE_ANON_KEY`, or `SUPABASE_SERVICE_ROLE_KEY` given a `NEXT_PUBLIC_` prefix, or Auth URLs not set | Fix the env vars (service_role must stay server-only), set Auth Site/Redirect URLs, redeploy |
| Dashboard doesn't update live | `appointments` / `notifications` missing from `supabase_realtime` | Re-run migration 3; check `pg_publication_tables` |
| SQL Editor error "already member of publication" | Realtime tables re-added by hand | Harmless — the migrations already added them; don't re-add |
| Data vanished from the dashboard | Someone ran `npm run db:seed` / `supabase db reset` against prod | Restore from a Supabase backup / `--data-only` dump; never run the seed against prod |
| WhatsApp stops after ~24 h | Token was a temporary USER token | Replace with a System User token (expiry Never); update the **WhatsApp account** credential |
| Portal returns errors after days idle | Supabase Free project **paused** after 7 days of inactivity | Un-pause it in the Supabase dashboard |

More failure modes and checks: `../Dentalclinic-dashboard/DEPLOYMENT_TROUBLESHOOTING.md`.

---

## Reference — what this system does NOT use in production

- **No** `N8N_ENCRYPTION_KEY` in the VM env — it lives in the volume.
- **No** `DB_TYPE=postgresdb` for n8n — it keeps SQLite on the VM disk (in `n8n_data`).
- **No** `OPENAI_API_KEY` — the agent runs on Groq.
- **No** Prisma / `DATABASE_URL` — the portal talks to Supabase directly.
- **No** re-import of the nine workflow JSON files on the VM — migrate by copying the volume.
- **No** `start-n8n-whatsapp.sh` on the VM — it would swap `WEBHOOK_URL` for a tunnel.
- **No** GitHub Actions / `vercel.json` — Vercel deploys straight from `main`.
