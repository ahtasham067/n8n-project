# SmileCare — Production Update Guide

How to take a change you made locally and ship it to production **without losing data or
breaking WhatsApp**. Covers the web portal (Vercel), the database (Supabase), and the n8n
agent + tool workflows (Oracle VM).

- First deploy from nothing → **`PRODUCTION_DEPLOYMENT.md`**.
- Production endpoints and IDs → the "Fill-in values" table in `PRODUCTION_DEPLOYMENT.md §C`.

---

## A. Golden rules (read before every change)

1. **Never** run `npm run db:seed`, `scripts/seed-supabase.ts`, or `supabase db reset`
   against the production Supabase project. The seed **deletes every row** in
   `notifications`, `appointments`, `doctor_blocks`, `clinic_settings`, `doctors`, `staff`,
   `clinics` before inserting demo data.
2. **Never** run `./start-n8n-whatsapp.sh` or `scripts/start-n8n.sh` on the VM. They start a
   Cloudflare tunnel and overwrite `WEBHOOK_URL` / `N8N_EDITOR_BASE_URL`, which breaks the
   Meta callback.
3. **Never** set `N8N_ENCRYPTION_KEY` in `~/smilecare-n8n/.env`. The real key is inside the
   `n8n_data` volume; a different value makes every stored credential undecryptable.
4. **Never** use `docker compose ... down -v` on the VM — `-v` deletes the `n8n_data`
   volume. Plain `down`, `stop`, `restart`, and `up -d` leave the external volume intact.
5. **Never** bump the n8n image off `docker.n8n.io/n8nio/n8n:2.34.6` without taking a fresh
   volume backup first — n8n's SQLite migrations run on start-up and are irreversible.
6. **Supabase schema changes must be additive** — new column / table / index / policy / RPC.
   No `drop column`, `drop table`, `alter type` on in-use values, or destructive bulk
   `update` on a live project.
7. **Meta allows one webhook callback per app.** While local and production share an app,
   activating a local or tunnel n8n instance steals the production subscription — keep local
   workflows **inactive** while prod is live. After the switch to separate apps (production
   `1755561068820381`, local `1452204086838529`), the callbacks no longer collide, but a
   number's messages reach **every app subscribed to its WABA**: keep the real number's WABA
   subscribed to the production app only, and keep the real number out of local
   `WHATSAPP_ALLOWED_PHONE_NUMBER_IDS`. See `WHATSAPP_REAL_NUMBER_SETUP.md`.
8. **`NEXT_PUBLIC_*` are compiled into the browser bundle.** Changing one on Vercel requires
   a **redeploy**, not just saving the variable.
9. **`lib/clinic-time.js` and `scripts/clinic-time-snippet.js` must change together.** The
   snippet is pasted verbatim into the Code nodes of the Book / Reschedule / Cancel / Get
   tool workflows (a trimmed copy in Cancel All); the Code nodes cannot `require()` the lib.
10. **The n8n instance on the VM is the runtime source of truth** once deployed. Keep the
    repo's workflow JSON in sync by exporting after every change.

---

## B. What changed → what to do

| You changed… | Do this |
| --- | --- |
| Web portal UI / an API route / anything under `src/**` | Commit → push to `main`. Vercel auto-builds and deploys. Verify on the production URL (§F). |
| Portal dependency or config (`package.json`, `next.config.ts`, `tsconfig.json`) | Same as above. If the Node version must change, set Vercel → Settings → General → Node.js Version **first**, then push. |
| A portal environment variable | Vercel → Settings → Environment Variables → edit → **Redeploy** (Deployments → ⋯ → Redeploy). Mandatory for any `NEXT_PUBLIC_*`. |
| DB schema, RLS policy, function, or RPC | New **additive** migration file → back up (§D) → `npx supabase db push` to the linked prod ref → verify (§F). Redeploy the portal only if it depends on the new shape. See §C-1. |
| Doctor / clinic reference data (hours, `clinic_settings`, a new doctor) | Edit through the portal's admin UI, **or** run a hand-written idempotent `insert … on conflict do update` in the SQL Editor. **Not** the seed script. |
| n8n workflow logic — the agent or any tool sub-workflow | Change the JSON in a PR, merge, then Actions → **Deploy** (`deploy/vm/README.md`): CI checks, your approval, volume backup, import by fixed id, publish, health check, automatic restore on failure. Manual fallback: §C-2, edit **in place** in the prod n8n UI and Download the JSON back to the repo. Never import as a new workflow; never delete + recreate. |
| An n8n Code-node script (`agent-error-fallback.js`, `clinic-time-snippet.js`) | Open the workflow on prod, edit the Code node's contents on the canvas, Save (§C-2). Keep `scripts/agent-error-fallback.js` / `scripts/clinic-time-snippet.js` and the repo JSON in sync. Remember rule A-9. |
| An n8n environment variable (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, URL vars, `TZ`, `CLINIC_TIMEZONE`) | Edit `~/smilecare-n8n/.env` on the VM → `docker compose -f docker-compose.prod.yml up -d` (recreates the container; workflows stay Active, credentials still decrypt). §C-3. |
| An n8n credential (WhatsApp token, Groq key, App Secret, SMTP) | §C-4. n8n UI on the VM, or `scripts/apply-whatsapp-auth.py` on the VM. Re-test with a **new** WhatsApp message. |
| Meta phone number / WABA / app identity | Update the affected credential(s) (§C-4), set `WHATSAPP_PHONE_NUMBER_ID` + `WHATSAPP_ALLOWED_PHONE_NUMBER_IDS` in `~/smilecare-n8n/.env` (§C-3 — replies already follow the inbound number), re-activate the workflow, run `scripts/diagnose-whatsapp-webhook.py`. |
| n8n version | §C-5. Discouraged — back up the volume, change the tag, `pull`, `up -d`, verify 9 workflows + credentials. |
| Adding `CliniDesk Scheduler.json` (SaaS release, free tiers) | It is in `deploy/vm/workflows.txt`, so **Deploy** imports and publishes it with the rest. Add `CLINIDESK_CRON_SECRET` to `~/smilecare-n8n/.env` (§C-3) first. Check that an execution every 15 min gets `200` from `/api/cron/platform-alerts`. |
| Supabase Auth URLs (new portal domain) | Supabase → Authentication → URL Configuration → update Site URL + Redirect URLs. No redeploy needed. |

---

## C. Procedures

### C-1. Supabase schema / migration change (safe, additive)

1. **Author an additive migration** in the dashboard repo:

   ```bash
   cd "/media/ahtasham/Partion C1/projects/Dentalclinic-dashboard"
   npx supabase migration new <short_name>       # creates supabase/migrations/<timestamp>_<short_name>.sql
   ```

   Write only additive DDL: `create table`, `add column … [default …]`, `create index …`,
   `create or replace function`, `create policy`, `alter publication … add table`. Give new
   `not null` columns a default. Do not drop or rename anything a running query depends on.

2. **Back up the data first** (§D — a `--data-only` dump).

3. **Apply to production** (the linked project):

   ```bash
   npx supabase link --project-ref iipilbnsfaiizzlzzfcv    # once per machine
   npx supabase db push
   ```

   Or paste just the new file into the Supabase **SQL Editor**.

4. **Verify** — run a query that touches the new object, plus the standard checks:

   ```sql
   select tablename from pg_publication_tables where pubname = 'supabase_realtime';
   -- still: appointments, notifications
   ```

5. **Redeploy the portal** only if its code now depends on the new column/RPC (push to
   `main`). n8n picks up new columns automatically (it speaks raw PostgREST); it only needs
   a workflow change if a tool must now read/write the new field.

**RLS changes:** after pushing, sign into the portal as a **non-admin** (`desk@smilecare.local`)
and confirm that user can still do exactly what they should and nothing more.

### C-2. n8n workflow change (safe, ID-preserving)

The normal path is the **Deploy** workflow (`deploy/vm/README.md`). Every file in `deploy/vm/workflows.txt` has the fixed id below, so its import updates the existing workflow instead of adding one, and it restores the volume backup if anything fails. The rules in this section are for changes made by hand.

**Why this needs care:** the agent calls each tool sub-workflow by a **hard-coded workflow
id** baked into its `toolWorkflow` nodes:

| Tool node | Sub-workflow id |
| --- | --- |
| `CheckDoctorAvailability` | `K3aQylfpGB7OIUmy` |
| `BookAppointment` | `vlxq9W4WX10a6sOt` |
| `CancelAppointment` | `YU0xJOfDAWTgu7ie` |
| `RescheduleAppointment` | `Z1FoatldEaEwpbS4` |
| `GetAppointment` | `L3GjYUaO84jum665` |
| `FindDoctor` (was `SearchDoctors`, same id) | `uv2kXklXGCUD8xid` |
| `GetDoctorDetails` | `GtDocDetails0001` |
| `FindEarliestSlots` | `FindEarliest0001` |
| `CancelAllAppointments` | `CaA1lAppt0000001` |

`GetDoctorDetails` and `FindEarliestSlots` are new with multi-doctor booking. They don't
exist on an n8n instance that predates it, so create each one **once** from its JSON
(`Tool - Get Doctor Details.json`, `Tool - Find Earliest Slots.json`) and check that n8n
kept the id in the file. If it gave a new id, put that id in the agent's matching
`toolWorkflow` node before activating. `Tool - Search Doctors.json` was replaced by
`Tool - Find Doctor.json`; edit that workflow in place (same id), don't add a second one.

If a sub-workflow gets a **new** id, the agent silently keeps calling the old one. The
repo's `Tool - *.json` files are exports without a reliable top-level `id`, so importing one
as a **new** workflow creates a fresh id and detaches it from the agent.

**Primary method — edit in place in the production n8n UI:**

1. Open `https://smilecare-n8n.duckdns.org` → **Workflows** → open the target workflow by
   name. Confirm the id in the browser URL (`/workflow/<id>`) matches the table above (for a
   tool) or is the agent's own id — this is the id you must not change.
2. Make the edit on that canvas (mirror what you prototyped locally). **Save.**
3. The id and, for the agent, the `webhookId` are unchanged. Credentials stay bound (they
   are referenced by credential id, which is identical on the VM).
4. Confirm the **Active** toggle is still on (re-enable if it dropped).
5. Export it back to the repo: **⋯ menu → Download** → overwrite the matching JSON file →
   commit, so version control matches production.

**Moving a local change without hand-editing on prod:** open the **existing** target
workflow on prod first (step 1), then **⋯ menu → Import from File** *while that workflow is
open* — n8n replaces the canvas of the **current** workflow and keeps its id. Immediately
re-check the URL id is unchanged, then Save and re-activate.

**After changing the *agent* workflow**, re-check:

- the **Dental Clinic Config** Set node still has `clinic_id = CLINIC-SMILECARE`,
  `doctor_id = DOC-003`, `doctor_name = Dr. Bilal Hussain`, `clinic_timezone = Asia/Karachi`;
- every `toolWorkflow` node still shows the id from the table above;
- run a real booking over WhatsApp and confirm the expected tool sub-workflow executed
  (n8n **Executions** shows the sub-workflow run).

**Never:**

- import a `Tool - *.json` (or the agent JSON) as a **new** workflow / new tab on prod — the
  new id detaches it from the agent (tools) or Meta (agent `webhookId`);
- re-import all nine JSON files onto a rebuilt n8n as an "update" — same problem, silently;
- delete a workflow and recreate it — new id / new `webhookId`;
- hand-edit connection wiring in the JSON instead of doing it on the canvas.

### C-3. n8n environment variable change

```bash
ssh -i <key> ubuntu@<VM_PUBLIC_IP>
cd ~/smilecare-n8n
cp .env .env.bak.$(date +%F-%H%M)     # keep the previous values
nano .env                              # edit
docker compose -f docker-compose.prod.yml up -d   # recreates n8n with the new env
docker compose -f docker-compose.prod.yml ps
curl -sf http://127.0.0.1:5678/healthz && echo OK
```

Workflows stay **Active** and credentials still decrypt across a recreate (the volume is
untouched). Keep `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` and never add `N8N_ENCRYPTION_KEY`.

### C-4. n8n credential change

**Via the UI (simplest):** `https://smilecare-n8n.duckdns.org` → **Credentials** → open the
credential → edit → **Save**. Applies immediately; no restart.

| Credential | n8n name | Holds |
| --- | --- | --- |
| `whatsAppApi` | WhatsApp account | WhatsApp API access token, WABA ID (Send Reply / voice nodes) |
| `whatsAppTriggerApi` | WhatsApp OAuth account | Meta App ID + **App Secret** (webhook signature) |
| `groqApi` | Groq account | Groq API key (LLM + Whisper) |
| `smtp` | SMTP account | error-alert email login |

**Via script (WhatsApp only), on the VM:** populate `WHATSAPP_ACCESS_TOKEN`,
`WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_CLIENT_ID`, `WHATSAPP_CLIENT_SECRET` in
`~/smilecare-n8n/.env`, then:

```bash
cd ~/smilecare-n8n         # scripts/ was copied here during the initial deploy;
                           # if missing: scp -i <key> -r scripts ubuntu@<VM_PUBLIC_IP>:~/smilecare-n8n/scripts
python3 scripts/apply-whatsapp-auth.py
```

It stops n8n, patches the `credentials_entity` rows in the volume's SQLite, and restarts.
The **WhatsApp account** and **WhatsApp OAuth account** credential rows must already exist
(they do, from the volume copy) or it only warns.

**After any WhatsApp credential change, test with a brand-new inbound message** — do not
"retry" an old failed execution (it replays stale payloads).

### C-5. n8n version bump (discouraged)

```bash
ssh -i <key> ubuntu@<VM_PUBLIC_IP>
cd ~/smilecare-n8n
# 1. back up the volume (see §D)
# 2. edit docker-compose.prod.yml -> image: docker.n8n.io/n8nio/n8n:<new-tag>
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
docker logs -f n8n            # watch migrations complete without error
```

Then verify all 9 workflows load, credentials decrypt, and the WhatsApp round trip works.
If anything is wrong, roll back the volume (§E) and revert the tag.

---

## D. Back up before any production change

**n8n volume — on the VM:**

```bash
ssh -i <key> ubuntu@<VM_PUBLIC_IP>
mkdir -p ~/backups
cd ~/smilecare-n8n
docker compose -f docker-compose.prod.yml stop n8n
docker run --rm -v n8n_data:/data -v ~/backups:/backup alpine \
  tar czf /backup/n8n_data-$(date +%F-%H%M).tar.gz -C /data .
docker compose -f docker-compose.prod.yml start n8n
ls -lh ~/backups
# optional: copy off-box from the laptop
# scp -i <key> ubuntu@<VM_PUBLIC_IP>:'~/backups/n8n_data-*.tar.gz' ./backups/
```

**Supabase — before any migration (data-only dump):**

```bash
cd "/media/ahtasham/Partion C1/projects/Dentalclinic-dashboard"
npx supabase db dump --data-only \
  --db-url "postgresql://postgres:<db-password>@db.iipilbnsfaiizzlzzfcv.supabase.co:5432/postgres" \
  -f "backup-data-$(date +%F-%H%M).sql"
# full schema+data: drop --data-only
```

On the Supabase **Pro** plan, Database → Backups gives automated daily backups + PITR — no
manual dump needed. **Free plan has no automated backups**, so the manual dump is your only
rollback point.

**Web portal:** Vercel keeps every previous deployment automatically — nothing to do.
**Workflow JSON:** commit the repo so the pre-change state is a git ref.

---

## E. Rollback

| Broke | Rollback |
| --- | --- |
| Web portal (bad code) | Vercel → Deployments → last good one → **⋯ → Promote to Production**. Or `git revert <sha> && git push`. |
| Web portal (bad env var) | Fix the variable in Vercel → **Redeploy**. |
| n8n workflow | Revert the change on the prod canvas (n8n keeps a version history per workflow: **⋯ menu → Workflow history**), **or** restore the volume backup below. |
| n8n env / credential / version | `cp .env.bak.<ts> .env` (or fix the credential in the UI) → `docker compose -f docker-compose.prod.yml up -d`. For a version bump, also revert the image tag. |
| n8n instance corrupted | On the VM: `cd ~/smilecare-n8n && docker compose -f docker-compose.prod.yml down` → `docker volume rm n8n_data` → recreate from the pre-change archive (`docker volume create n8n_data` + `tar xzf` as in `PRODUCTION_DEPLOYMENT.md §D-3`) → `docker compose -f docker-compose.prod.yml up -d`. |
| Supabase schema | Write a compensating **additive** migration (e.g. re-add a dropped column). There is no "undo migration". |
| Supabase data | Restore the `--data-only` dump via `psql` into the project (or a fresh project); PITR on Pro. |
| WhatsApp inbound/replies | Restore the previous token / `WHATSAPP_PHONE_NUMBER_ID` + `WHATSAPP_ALLOWED_PHONE_NUMBER_IDS` / App Secret, re-activate the workflow (re-registers the callback), then run `scripts/diagnose-whatsapp-webhook.py`. |

---

## F. Verify after the update

**Always (core round trip):**

```bash
curl -I https://smilecare-n8n.duckdns.org/healthz          # 200
cd "/media/ahtasham/Partion C1/projects/n8n-project" && npm test   # offline unit tests
```

- Send "hi" from a Meta-verified WhatsApp number → n8n **Executions** shows a green run →
  a reply arrives.
- Insert one appointment as `service_role` for `CLINIC-SMILECARE` / `DOC-003` (curl in
  `PRODUCTION_DEPLOYMENT.md §E step 4`) → the open dashboard shows a toast + bell **without
  refresh** → cancel the test row.

**Targeted by change type:**

| Change | Extra check |
| --- | --- |
| Portal code/deps | Open the exact screen you changed on `https://dentalclinic-dashboard.vercel.app`; read the Vercel build log for warnings. |
| Portal env var | Confirm the running deployment used the new value (redeploy timestamp is newer than the edit). |
| DB migration | The verify SQL in §C-1 + a query hitting the new table/column/RPC; sign in as `desk@smilecare.local` and re-check RLS. |
| n8n workflow | In **Executions**, run the affected path end to end (e.g. actually book, reschedule, cancel over WhatsApp). Confirm the correct tool sub-workflow fired. |
| n8n credential | Send a **new** WhatsApp message (never retry an old execution). For WhatsApp: `python3 scripts/verify-whatsapp-token.py` and `scripts/diagnose-whatsapp-webhook.py`. |
| n8n env var | `docker exec n8n printenv SUPABASE_URL N8N_BLOCK_ENV_ACCESS_IN_NODE WEBHOOK_URL` shows the new values; run a booking to confirm DB writes still land. |
| n8n version | All 9 workflows load, every credential opens without a decrypt error, WhatsApp round trip works. |

---

## G. Mistakes that cause data loss or an outage

- Running the seed / `supabase db reset` against the production project — **wipes all
  appointments**.
- Pointing local `.env` or `.env.cloud` at the production Supabase URL and then running a
  seed or an E2E script that deletes rows.
- `docker compose ... down -v` on the VM — deletes the `n8n_data` volume (workflows +
  credentials + history).
- Re-importing all nine workflow JSON files onto a rebuilt n8n — new sub-workflow IDs, the
  agent's tool calls fail silently.
- Deleting and recreating a workflow instead of importing over it — new `webhookId`, Meta
  callback starts returning 404.
- Setting `N8N_ENCRYPTION_KEY` in the VM `.env` — every stored credential becomes
  undecryptable.
- Running `start-n8n-whatsapp.sh` / `scripts/start-n8n.sh` on the VM — rewrites `WEBHOOK_URL`
  to a Cloudflare tunnel and detaches the Meta webhook.
- A destructive migration (`drop`/`rename`/`alter type`) on a live project — no undo.
- Activating a local or tunnel n8n while production is live — steals the single Meta callback
  so production stops receiving messages.
- Editing `lib/clinic-time.js` without updating `scripts/clinic-time-snippet.js` in the tool
  workflows (or vice-versa) — times render/store inconsistently.
- Forgetting to redeploy Vercel after changing a `NEXT_PUBLIC_*` variable — the old value
  stays baked in the bundle.
- Bumping the n8n image tag without a volume backup — SQLite migrations are irreversible.
- Writing `appointment_time` in a new format on one side only — `"9:00"` and `"09:00"` both
  pass the `appointments_active_slot_uidx` partial unique index, so inconsistent formatting
  lets a slot be double-booked.
