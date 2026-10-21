# Connect the clinic's real WhatsApp number (local first, then production)

How to move Dr. Usama's Gastro & Hepatology Clinic WhatsApp agent from Meta's **test number**
to the clinic's **real number** (a new SIM that has never been on WhatsApp). Test it end to end
on the local stack first, then move the same number to production on the Oracle VM.

- Steps marked **[YOU]** are manual actions in Meta's interface or on your phone. Nobody has
  done them for you.
- Part D (production) is **approval-gated**. Nothing in it has been executed.
- Meta renames menus often. Labels below match the interface and docs as of October 2026.
  Some newer Meta pages say **"Messaging account"** or **"WhatsApp account"** where older
  ones say **WhatsApp Business Account (WABA)**. They are the same thing.
- Never paste tokens, App Secrets or PINs into this file, workflow JSON, or any tracked file.

**Order of work:** read §1–§3, then do Part A (Meta), Part B (local config), and Part C
(local tests). Do Part D (production) only after Part C passes and you approve the cutover.

---

## 1. Audit of the current integration (2026-10-21)

Inspected read-only: repo files, the local n8n database copy, and Graph API `GET` calls.
Nothing was sent or changed in Meta.

### Meta side

| Item | Value / state |
|---|---|
| Business portfolio | "Dr Appointment Syatem" — `921261627705693`, **not verified** (health error `141010`, status LIMITED) |
| Local Meta app | "Appointment Syatem Local" — App ID `1452204086838529` |
| Second Meta app | "Appointment Syatem" — App ID `1755561068820381` (**chosen for production**) |
| Current WABA | "Test WhatsApp Business Account" — `1628386515555176` |
| WABA health | **`can_send_message: BLOCKED`**. Error `141006`: payment method error, which blocks business-initiated messages |
| Current sender | `+1 555-205-1341` "Test Number" (Meta test number). Phone Number ID `1296266210241103`, CONNECTED, quality GREEN, TIER_250 |
| Apps subscribed to the WABA | `1452204086838529` (Local), `1755561068820381` ("Appointment Syatem"), and Meta's internal "WA DevX Webhook Events 1P App" (ignore it) |
| Webhook (app 1452…) | object `whatsapp_business_account`, field `messages`, active. Callback is the current `trycloudflare.com` tunnel, so **local n8n currently receives the test number's messages** |
| Access token (`.env.docker`) | System User token, never expires. Scopes `whatsapp_business_messaging` and `whatsapp_business_management`. Issued for app 1452… |
| Message templates | Only Meta's samples (`hello_world`, `jaspers_market_*`). **No clinic templates** |

### n8n / repo side

| Item | State |
|---|---|
| n8n version | `2.34.6`, both locally and pinned in production |
| Agent workflow | `nmXYYzPxvgMRZpm7`, active. WhatsApp Trigger webhookId `e60f653f-a2f6-4686-909b-f3cca62cad2c`. Verify token is the trigger node id `4d182743-5c30-44b2-8bb7-b346135a7e70` |
| Inbound path | WhatsApp Trigger → Normalize → **Allowed Business Number?** *(new)* → Detect Message Type → (voice: download + Groq transcription) → Dental Clinic Config → Only Real Messages → Agent (8 tool sub-workflows → Supabase) → Send WhatsApp Reply |
| Credentials | **WhatsApp account** (`whatsAppApi`: token + WABA ID), used by Send Reply and voice download. **WhatsApp OAuth account** (`whatsAppTriggerApi`: App ID + App Secret), used by the trigger to register the webhook and verify `X-Hub-Signature-256` |
| How the webhook is registered | When you publish the agent, n8n calls `POST /{app-id}/subscriptions` with the App ID and App Secret. This is **app-level**: n8n then receives messages for **every WABA subscribed to that app**. Unpublishing deletes the subscription |
| Sender (before this change) | **Hardcoded** `phoneNumberId: "1296266210241103"` in *Send WhatsApp Reply* and in *Send WhatsApp Notification* (`Send Notification.json`) |
| `Send Notification` workflow | In the repo, but **not imported** into local n8n. Needs `N8N_NOTIFY_SHARED_SECRET`, which is not set locally. Sends free-form text, so delivery is only reliable inside the 24-hour window |
| Docs | `PRODUCTION_DEPLOYMENT.md` had the Meta App Secret in plain text. It has been **redacted**. The file was never committed. Rotate the secret if the file was ever shared |

### What was wrong for a real number, and what changed

1. **Replies would come from the wrong number.** The real number's messages would reach n8n
   (once its WABA is subscribed to the app), but the reply would be sent from the hardcoded
   test number. That fails or confuses patients.
   **Fixed:** *Normalize WhatsApp Message* now captures `phone_number_id` from the webhook,
   and *Send WhatsApp Reply* sends from that number. `WHATSAPP_PHONE_NUMBER_ID` is the fallback.
2. **No way to keep environments apart.** Any number subscribed to the app was answered.
   **Fixed:** the new IF node **Allowed Business Number?** drops messages to numbers that are
   not in `WHATSAPP_ALLOWED_PHONE_NUMBER_IDS`. If the variable is unset, every number is
   answered, as before.
3. **Notifications hardcoded the test sender.** **Fixed:** `Send Notification.json` uses
   `$env.WHATSAPP_PHONE_NUMBER_ID`.
4. **Scripts.**
   - `verify-whatsapp-token.py` now reads the sender and recipient from env, has a read-only
     `--no-send` mode, and reports WABA health.
   - `diagnose-whatsapp-webhook.py` checks the `PHONE_NUMBER_ID` env var instead of a stale ID.
   - `start-n8n.sh` prints the sender profile it starts with.
5. **Guard rail.** `npm run test:whatsapp` fails if a Phone Number ID is ever hardcoded again,
   or if the workflow or tool IDs change.

> `npm test` also runs `test:language`, which **was already failing before this change**: the
> agent's system prompt no longer contains the phrases it checks. That is unrelated to
> WhatsApp routing. Run `npm run test:whatsapp` on its own until it is fixed.

---

## 2. Sender vs recipient, test number vs real number

| Term | What it is | Where it appears |
|---|---|---|
| **Sender / business number** | The clinic's number that patients message. Today it is the test number `+1 555-205-1341`; after this guide it is the new SIM | Identified in the API **only by its Phone Number ID** (a long numeric ID, *not* the phone number). Webhook `metadata.phone_number_id`; env `WHATSAPP_PHONE_NUMBER_ID` |
| **Recipient / patient number** | Any WhatsApp user. For testing, **your personal phone** | `wa_id` in international format **without `+`**, e.g. `923001234567`. Webhook `messages[0].from`; workflow `phone_number`; DB `appointments.phone_number`; env `WHATSAPP_TEST_RECIPIENT` |

You cannot test by messaging the business number from itself. The clinic SIM is the
**sender**, and your personal phone is the **patient**.

| Rule | Meta **test number** | **Real** registered number |
|---|---|---|
| Who can it message? | Only up to 5 recipient numbers you add in *API Setup → To* (otherwise error `131030`) | Anyone on WhatsApp |
| Who can message it? | Anyone. Replies still only go to allow-listed recipients | Anyone |
| Free-form (non-template) replies | Only within 24 h of the recipient's last message | Same: within 24 h of the patient's last message (the "customer service window") |
| Outside the 24 h window | Templates only | Templates only. Free-form gets `131047` |
| Business-initiated limit | 250 unique users / 24 h | Starts at 250 unique users / 24 h **per business portfolio** (outside service windows) |
| Display name | Fixed ("Test Number") | Your display name, subject to review |
| Billing | Free | Per-message pricing (see §11). **Needs a payment method** |
| Can the number also run the WhatsApp app? | n/a | **No.** A Cloud API number cannot be used in the regular WhatsApp or WhatsApp Business app (unless onboarded through coexistence, §3) |

---

## 3. Phone number considerations

**Your situation: new SIM that has never been on WhatsApp.** This is the cleanest path.
Nothing has to be deleted, and no chat history is lost.

- [YOU] **Do not install or register WhatsApp or WhatsApp Business on this SIM**, not even
  "to test". A number already registered with WhatsApp cannot be added to Cloud API until
  that account is deleted.
- The SIM must be able to receive an **SMS or a voice call** for the one-time verification
  code. Keep it active and topped up. You need it again if Meta ever asks you to re-verify.
- After verification, the SIM does not need to stay in a phone. Messages flow through the API,
  not the handset. **Keep the SIM in your possession anyway.** Losing the number means losing
  the clinic's WhatsApp identity.

**For reference, if a number is already on WhatsApp:**

| Current state | Options | Consequences |
|---|---|---|
| Regular (personal) WhatsApp | Delete the WhatsApp account in the app (*Settings → Account → Delete account*), wait a few minutes, then add it to Cloud API | Chat history, groups and backups for that number are gone unless you export them first. You can't use that number in the WhatsApp app any more |
| WhatsApp Business app | (a) Delete the account, with the same consequences as above. (b) **Coexistence**: keep the app and the API on the same number | Coexistence needs onboarding through Embedded Signup by a **Meta Solution Partner or Tech Provider**, and Business app ≥ 2.24.17. It syncs contacts and the last 6 months of 1:1 chats. Throughput is fixed at 20 msg/s. Groups, broadcast lists, disappearing / view-once messages and calls are not available through the API. **Not needed for a new SIM** |

Don't delete or disconnect an existing WhatsApp account until you've read the consequences
above and decided it's acceptable.

---

## Part A — Meta setup for the real number (all [YOU])

Do these in order. Keep a private note of each ID as you go (§8).

### A1. Check the business portfolio
1. Open **business.facebook.com** → **Settings** (Business settings / Business portfolio
   settings) → **Business info**. Confirm you're in **"Dr Appointment Syatem"**
   (`921261627705693`).
2. Fix the business name, address, website and email now if needed. Verification (A9) checks
   them against your documents.

### A2. Add a working payment method
Both the test WABA and any new WABA need one.

1. **business.facebook.com → Billing & payments**. Meta's docs call this **Billing Hub**.
   You can also open it from **WhatsApp Manager → (⋯) → Billing**.
2. **Add payment method** (card), then attach it to the WhatsApp Business Account(s).
3. Fix the existing error `141006` on the test WABA the same way.

Why: from **1 Oct 2026**, without a payment method nothing beyond the free tier is delivered
(§11).

### A3. Add the number and create a real WABA
1. **developers.facebook.com → My Apps → "Appointment Syatem Local"** → left menu **WhatsApp →
   API Setup**.
2. Under the step **"Add a phone number"**, click **Add phone number**.
3. In the dialog:
   - **Business portfolio**: Dr Appointment Syatem.
   - **WhatsApp Business Account**: choose **Create a new WhatsApp Business Account**. Don't
     reuse "Test WhatsApp Business Account". Name it something like *Dr Usama Clinic*.
   - **Timezone / currency**: Asia/Karachi. Pick the currency you want to be billed in. It is
     hard to change later.
   - **Business profile**:
     - Display name `Dr. Usama's Gastro & Hepatology Clinic`. It must match how the business
       presents itself, and should not be generic or contain only a person's name.
     - Category **Medical & Health**.
     - Optional description and website.
4. **Phone number**: choose country **Pakistan (+92)** and enter the SIM's number. Choose
   **Text message** (or **Phone call** if SMS doesn't arrive).
5. Enter the 6-digit code from the SIM, then click **Next / Done**.

Alternative route: **business.facebook.com → WhatsApp Manager → Account tools → Phone numbers
→ Add phone number**.

Adding and verifying the number is **not** the same as registering it. It shows as not
connected until A6.

### A4. Copy the two IDs
- **developers.facebook.com → app → WhatsApp → API Setup**. In the **From** dropdown, select
  the new number. Copy its **Phone number ID** and **WhatsApp Business Account ID**. These are
  `<REAL_PHONE_NUMBER_ID>` and `<REAL_WABA_ID>` below.
- Or: **WhatsApp Manager → Account tools → Phone numbers**. Click the number to see its ID.

### A5. Give the existing System User access to the new WABA
1. **business.facebook.com → Settings → Users → System users** → select the system user whose
   token is in `.env.docker`.
2. Click **Assign assets → WhatsApp accounts** → select the new WABA → enable **Full control**
   (or *Manage WhatsApp Business Account*) → **Save / Assign**.
3. Usually the existing token now covers the new WABA too. Check it in B1 with
   `verify-whatsapp-token.py --no-send`. **Only if that fails** with a permission error: click
   **Generate new token** → choose app **Appointment Syatem Local** → permissions
   `whatsapp_business_messaging` and `whatsapp_business_management` → expiration **Never**.
   Copy it once into `.env.docker` and your password manager.

### A6. Register the number with Cloud API (one API call)
Meta only allows registration through the API. Choose a **new 6-digit PIN**. It becomes the
number's two-step verification PIN. **Store it in a password manager.** You need it to
re-register, change the PIN, or delete the number.

```bash
cd "/media/ahtasham/Partion C2/projects/n8n-project"
GRAPH=https://graph.facebook.com/v21.0          # any current Graph version works (Meta docs show v26.0)
TOKEN=$(grep '^WHATSAPP_ACCESS_TOKEN=' .env.docker | cut -d= -f2-)
read -rsp "New 6-digit PIN: " PIN; echo
curl -s -X POST "$GRAPH/<REAL_PHONE_NUMBER_ID>/register" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"messaging_product\":\"whatsapp\",\"pin\":\"$PIN\"}"
unset PIN
```

Expect `{"success":true}`. The limit is **10 register calls per number per 72 h**. Exceeding
it returns `133016` and blocks registration for 72 h, so don't retry in a loop.

### A7. Subscribe the local app to the new WABA
This makes the real number's inbound messages reach the app's webhook, which is local n8n.
The token belongs to app 1452…, so the call subscribes that app.

```bash
curl -s -X POST "$GRAPH/<REAL_WABA_ID>/subscribed_apps" -H "Authorization: Bearer $TOKEN"
curl -s "$GRAPH/<REAL_WABA_ID>/subscribed_apps" -H "Authorization: Bearer $TOKEN"
# expect "Appointment Syatem Local" (1452204086838529) in the list
```

**Do not** subscribe the production app (1755…) yet. That is a cutover step (D4).

### A8. Display name status
**WhatsApp Manager → Account tools → Phone numbers** → the number → **Name status**.
- `APPROVED` or `AVAILABLE_WITHOUT_REVIEW`: ready.
- `PENDING_REVIEW`: wait.
- `DECLINED`: edit the name to follow Meta's display-name rules and resubmit.

`verify-whatsapp-token.py --no-send` prints `name_status` too.

### A9. Business verification (recommended before production)
**business.facebook.com → Settings → Security Center** (or **Business info → Business
verification**) → **Start verification**. Upload the clinic's legal documents and verify
the domain, email or phone when asked.

Why it matters:
- Unverified portfolios stay at **250** business-initiated users / 24 h.
- They can register at most **2** numbers.
- They are limited to **250** templates.

Verification is a scaling path to 2,000, up to 20 numbers, and 6,000 templates (§11).

### A10. Create message templates
Templates are needed for anything sent outside the 24 h window, such as reminders and
dashboard notifications. **WhatsApp Manager → Account tools → Message templates → Create
template**. Select the **new WABA** first: templates are per WABA, so the test WABA's
templates don't carry over.

- Category: **Utility**. Don't use promotional wording, or Meta recategorizes the template as
  Marketing.
- Create each template in **English (`en`)** and **Urdu (`ur`)**.
- Suggested templates:
  - `appointment_confirmation`: "Hello {{1}}, your appointment with {{2}} is confirmed for
    {{3}} at {{4}}. Reply here to reschedule or cancel."
  - `appointment_reminder`: "Reminder: {{1}}, you have an appointment with {{2}} on {{3}} at
    {{4}}. Reply here if you need to change it."
  - `appointment_cancelled`: "Hello {{1}}, your appointment on {{2}} at {{3}} has been
    cancelled. Reply here to book a new time."
- Approval usually takes minutes to hours. Check the **Status** column.

> The agent's normal conversation doesn't need templates. It replies inside the 24 h window
> the patient opened. `Send Notification` still sends **free-form text**. Switching it to the
> n8n WhatsApp node's **Send Template** operation is a follow-up that also needs a change on the
> dashboard side. Until then, notifications only deliver to patients who messaged in the last 24 h.

### A11. App mode (only if needed)
Messages webhooks work while the app is in **Development** mode, which is what you have now.
If, in Part C, the real number's messages from your personal phone **never** reach n8n even
though A6 and A7 succeeded:
1. **developers.facebook.com → app → App settings → Basic**. Fill in **Privacy Policy URL**,
   **App icon**, **Category** and **User data deletion** (a URL or instructions).
2. Switch **App Mode** to **Live** (the top bar toggle, or **Publish**).

A Business app that only manages your own WABA doesn't need App Review for these two
permissions. The production app (1755…) should be Live anyway (D1).

---

## Part B — Local configuration

### B1. `.env.docker`: switch to the "local testing of real number" profile
`.env.docker` now has a WhatsApp sender block. Today it runs the **TEST** profile. After Part A,
edit those lines:

```ini
WHATSAPP_BUSINESS_ACCOUNT_ID=<REAL_WABA_ID>
WHATSAPP_PHONE_NUMBER_ID=<REAL_PHONE_NUMBER_ID>
WHATSAPP_ALLOWED_PHONE_NUMBER_IDS=1296266210241103,<REAL_PHONE_NUMBER_ID>
WHATSAPP_TEST_RECIPIENT=<PATIENT_NUMBER>       # your personal phone, e.g. 923001234567 (no +)
```

What each one does:
- `WHATSAPP_ALLOWED_PHONE_NUMBER_IDS` lists **both** numbers, so local n8n answers the test
  number and the real number.
- `WHATSAPP_PHONE_NUMBER_ID` is the fallback sender. It is also the sender for Send
  Notification and `verify-whatsapp-token.py`.
- `WHATSAPP_BUSINESS_ACCOUNT_ID` is synced into the **WhatsApp account** credential by
  `apply-whatsapp-auth.py`. It is only used for n8n's dropdowns and template lists.
- `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_CLIENT_ID` and `WHATSAPP_CLIENT_SECRET` don't change: same
  local app, same System User.

To go back to the test number: set both ID vars to `1296266210241103`, set
`WHATSAPP_BUSINESS_ACCOUNT_ID=1628386515555176`, and repeat B3.

Read-only check, which sends nothing:

```bash
python3 scripts/verify-whatsapp-token.py --no-send
```

Expect:
- `Token app: Appointment Syatem Local`
- `Sender: +92 … (Dr. Usama's …)`
- `status: CONNECTED`
- no `WARN WABA 141006` (if it appears, finish A2)

### B2. Import the updated agent workflow into local n8n (one time)
The repo's `WhatsApp AI Appointment Booking Agent.json` has the new routing. Import it **into
the existing workflow** so its ID and webhook stay the same. A backup of the current version is
at `backups/agent-pre-real-number-2026-10-21.json`.

1. Open **http://localhost:5678** → **Workflows** → **WhatsApp AI Appointment Booking Agent**.
   Check that the URL ends in `/workflow/nmXYYzPxvgMRZpm7`.
2. Open the **⋯** menu (top right) → **Import from File…** → choose the repo JSON.
3. Check the canvas:
   - *Normalize WhatsApp Message* → **Allowed Business Number?** → *Detect Message Type*.
   - *Send WhatsApp Reply → Phone Number ID* shows an expression.
   - The URL ID is unchanged.
4. **Save**. Don't publish yet (see B3).

Optional: to test dashboard notifications locally, import `Send Notification.json` as a new
workflow and add `N8N_NOTIFY_SHARED_SECRET=<random-string>` to `.env.docker`. Use the same value
the local dashboard sends in `X-Notify-Secret`.

### B3. Restart sequence (each time `.env.docker` or the tunnel changes)
The quick tunnel gets a **new URL on every run**. n8n refuses to publish if Meta still has
the old URL ("*already has a webhook subscription*"). Always use this order:

1. In n8n, open the agent → **Unpublish** (older UI: Active toggle **off**). n8n deletes the
   app's webhook subscription.
2. Run `./start-n8n-whatsapp.sh`. Never use bare `docker run` or `docker compose up`.
   - It recreates the container with the new env.
   - It syncs the WhatsApp credentials.
   - It prints `WHATSAPP_PHONE_NUMBER_ID=…` and `WHATSAPP_ALLOWED_PHONE_NUMBER_IDS=…`.
   - Confirm both are what you expect.
3. In n8n, open the agent → **Publish** (Active **on**). n8n registers the new callback with
   Meta. The tool sub-workflows stay published as they are.
4. Optional check: **developers.facebook.com → app (Local) → WhatsApp → Configuration** shows
   the Callback URL `https://<new>.trycloudflare.com/webhook/e60f653f-a2f6-4686-909b-f3cca62cad2c/webhook`
   with the **messages** field subscribed.

### B4. Webhook verification details (normally automatic)
- **Callback URL**: `<WEBHOOK_URL>webhook/e60f653f-a2f6-4686-909b-f3cca62cad2c/webhook`
  (`WEBHOOK_URL` ends with `/`).
- **Verify token**: `4d182743-5c30-44b2-8bb7-b346135a7e70`, the WhatsApp Trigger's node ID.
  n8n answers Meta's `hub.challenge` with it.
- **Signature**: n8n checks `X-Hub-Signature-256` with the **App Secret** stored in the
  *WhatsApp OAuth account* credential. If they don't match, Meta gets HTTP 200 but **no
  execution appears**.
- **Fields**: only `messages` is needed.

Only if automatic registration fails: in **WhatsApp → Configuration → Webhook → Edit**, paste
the callback URL and verify token → **Verify and save** → **Webhook fields → Manage** →
subscribe **messages**.

---

## Part C — Local testing checklist

Use your personal phone as the patient. Watch **n8n → Executions** while you test. Each
message creates one agent execution, plus separate executions for any tool sub-workflows it
calls.

**Setup helpers:**

```bash
cd "/media/ahtasham/Partion C2/projects/n8n-project"
GRAPH=https://graph.facebook.com/v21.0
TOKEN=$(grep '^WHATSAPP_ACCESS_TOKEN=' .env.docker | cut -d= -f2-)
KEY=$(grep '^SUPABASE_SERVICE_ROLE_KEY=' .env.docker | cut -d= -f2-)
PATIENT=<PATIENT_NUMBER>      # e.g. 923001234567
appts() { curl -s "http://127.0.0.1:54321/rest/v1/appointments?clinic_id=eq.CLINIC-SMILECARE&phone_number=eq.$PATIENT&select=appointment_id,appointment_date,appointment_time,status,source,created_at&order=created_at.desc&limit=5" -H "apikey: $KEY" -H "Authorization: Bearer $KEY"; echo; }
```

Don't run the dashboard's `seed-supabase.ts` or `supabase db reset` during these tests. Both
delete all appointments.

| # | Test | How | Expected |
|---|---|---|---|
| 1 | Token and sender | `python3 scripts/verify-whatsapp-token.py --no-send` | Token valid, sender = clinic number, `CONNECTED`, no WABA errors |
| 2 | Stack up | `./start-n8n-whatsapp.sh` (B3) | Tunnel healthz 200, Supabase smoke test returns DOC-003, WhatsApp env vars printed |
| 3 | **Inbound reaches n8n** | From your personal phone, send `hi` to the **clinic number** | New agent execution. *Normalize WhatsApp Message* output: `phone_number` = your number, `phone_number_id` = `<REAL_PHONE_NUMBER_ID>`. *Allowed Business Number?* took the **true** branch |
| 4 | **AI reply from the real number** | Same message | A reply arrives in your chat **with the clinic number / display name**, not `+1 555…`. *Send WhatsApp Reply* output has `messages[0].id` (`wamid…`) |
| 5 | Outbound free-form | Within 24 h of #3: `python3 scripts/verify-whatsapp-token.py` (no `--no-send`) | "SmileCare token verification ping" arrives on your phone from the clinic number |
| 6 | Outbound template (optional, costs one utility message) | After a template is approved (A10): `curl -s -X POST "$GRAPH/<REAL_PHONE_NUMBER_ID>/messages" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"messaging_product":"whatsapp","to":"'"$PATIENT"'","type":"template","template":{"name":"appointment_confirmation","language":{"code":"en"},"components":[{"type":"body","parameters":[{"type":"text","text":"Test"},{"type":"text","text":"Dr. Usama"},{"type":"text","text":"tomorrow"},{"type":"text","text":"10:00 AM"}]}]}}'` | Template arrives. This works even outside the 24 h window |
| 7 | Doctor / clinic info | "What are the clinic timings?" / "Which doctor is available?" | *GetClinicInfo* / *SearchDoctors* executions succeed, and the answer matches the dashboard |
| 8 | Availability and **booking** | "I want an appointment tomorrow at 10 am" → follow the prompts → confirm | *CheckDoctorAvailability* then *BookAppointment* succeed. `appts` shows a new row `status=booked`, `source=whatsapp`, with your number. It also appears in the dashboard |
| 9 | Get appointment | "Show my appointment" | *GetAppointment* returns the booking. Times are shown in Asia/Karachi |
| 10 | **Reschedule** | "Move it to the day after at 11 am" | *RescheduleAppointment* succeeds. `appts` shows the new date and time |
| 11 | **Cancel** / cancel all | "Cancel my appointment" (then book two and try "cancel all") | *CancelAppointment* / *CancelAllAppointments* succeed. Rows become `cancelled` |
| 12 | Voice note | Send a short voice note: "appointment chahiye kal" | *Get WhatsApp Audio* → *Download Voice Note* → *Transcribe* succeed (this proves the token can read media on the new WABA). The reply is in the same language |
| 13 | Language | Message in Urdu script, Roman Urdu and English | Each reply matches the language. Never Hindi / Devanagari |
| 14 | Error path: wrong date | Ask for a date in the past | The tool rejects it, and the agent explains politely |
| 15 | Error path: fallback | (Optional) Temporarily use an invalid Groq key, or send many messages quickly | *Agent Error Fallback* sends a sensible message. No fabricated booking. Restore the key afterwards |
| 16 | **Guard drops other numbers** | Temporarily set `WHATSAPP_ALLOWED_PHONE_NUMBER_IDS=1296266210241103`, then B3 again, then message the clinic number | The execution stops at *Allowed Business Number?* (false branch, no reply). Restore both IDs and run B3 again |
| 17 | Test number still works | Message `+1 555-205-1341` from your phone (it must be in API Setup's allowed list) | The reply comes **from the test number**. This proves sender routing per number |
| 18 | Logs clean | n8n **Executions** filtered by *Error*, plus `docker logs n8n --since 30m` | No unexpected errors. The Error Handler email only fired for intentional tests |

**Reading executions:** open an execution and click each node to see its input and output.
`Send WhatsApp Reply` success means **Meta accepted** the message. Delivery failures (for
example `131047`) arrive later as status webhooks, which this workflow ignores. If the patient
doesn't receive a reply even though the node is green, check §10.

---

## Part D — Production (approval-gated; nothing here has been done)

Production runs on the Oracle VM (`https://smilecare-n8n.duckdns.org`). Its `n8n_data` volume
was copied from local, so it currently has the same credentials (app 1452…) and the old
hardcoded workflow.

The target state:

| | Local dev | Production |
|---|---|---|
| Meta app | "Appointment Syatem Local" `1452204086838529` | "Appointment Syatem" `1755561068820381` |
| Callback | trycloudflare tunnel | `https://smilecare-n8n.duckdns.org/webhook/e60f653f-a2f6-4686-909b-f3cca62cad2c/webhook` |
| Numbers answered (`WHATSAPP_ALLOWED_PHONE_NUMBER_IDS`) | test number only | real number only |
| Real WABA `subscribed_apps` | **not** 1452… | 1755… |

Follow `PRODUCTION_UPDATE.md` for every VM change. Back up the `n8n_data` volume first.
Never run `start-n8n-whatsapp.sh` on the VM.

### D1. [YOU] Prepare the production app (1755…)
1. **developers.facebook.com → "Appointment Syatem" → App settings → Basic**:
   - Note the **App ID** (`1755561068820381`).
   - Reveal the **App Secret** and copy it to your password manager.
   - Fill in Privacy Policy URL, icon, category and data deletion.
   - Set **App Mode → Live**.
2. Check that **WhatsApp** is listed under the app's products.
3. **business.facebook.com → Settings → Users → System users**. Use a dedicated system user
   for production if possible, for example `smilecare-prod`.
   - **Assign assets**:
     - **Apps** → Appointment Syatem → *Manage app*.
     - **WhatsApp accounts** → the real WABA → *Full control*.
   - **Generate new token**:
     - App **Appointment Syatem**.
     - Permissions `whatsapp_business_messaging` and `whatsapp_business_management`.
     - Expiration **Never**.
   - Copy the token once into your password manager.
4. Check it: `curl -s "https://graph.facebook.com/v21.0/debug_token?input_token=<PROD_TOKEN>" -H "Authorization: Bearer <PROD_TOKEN>"`
   should show `"app_id":"1755561068820381"`, `"type":"SYSTEM_USER"`, `"expires_at":0`.

### D2. Production env (VM `~/smilecare-n8n/.env`)
Add the following, then recreate the container with
`docker compose -f docker-compose.prod.yml up -d` (see `PRODUCTION_UPDATE.md` C-3; back up
`.env` first):

```ini
WHATSAPP_PHONE_NUMBER_ID=<REAL_PHONE_NUMBER_ID>
WHATSAPP_ALLOWED_PHONE_NUMBER_IDS=<REAL_PHONE_NUMBER_ID>
```

If you sync credentials with the script instead of the UI, also set
`WHATSAPP_ACCESS_TOKEN=<PROD_TOKEN>`, `WHATSAPP_BUSINESS_ACCOUNT_ID=<REAL_WABA_ID>`,
`WHATSAPP_CLIENT_ID=1755561068820381` and `WHATSAPP_CLIENT_SECRET=<prod app secret>`. See
`deploy/.env.production.example`.

### D3. Production workflow and credentials (VM n8n UI)
1. Open the agent on the VM → **Unpublish**. Its credential still points at app 1452…, so this
   removes app 1452's subscription. That may also be local's subscription: re-publish locally
   later if you still need the test number.
2. **Credentials → WhatsApp OAuth account**:
   - Client ID: `1755561068820381`.
   - Client Secret: the prod App Secret.
   - Save.
3. **Credentials → WhatsApp account**:
   - Access Token: `<PROD_TOKEN>`.
   - Business Account ID: `<REAL_WABA_ID>`.
   - Save.
4. Import the updated agent JSON **into the open existing workflow** (`PRODUCTION_UPDATE.md`
   C-2: ⋯ → Import from File, check the URL ID is unchanged) → **Save**.
5. Re-check *Dental Clinic Config* and the tool IDs, as listed in C-2.
6. Optional: import or update `Send Notification` the same way, if the dashboard uses it in
   production.

### D4. Cutover order (avoids double replies and gaps)
Do these steps one at a time.

1. **Local stops answering the real number.**
   - Set local `WHATSAPP_ALLOWED_PHONE_NUMBER_IDS=1296266210241103` and
     `WHATSAPP_PHONE_NUMBER_ID=1296266210241103`.
   - Set `WHATSAPP_BUSINESS_ACCOUNT_ID` back to `1628386515555176`.
   - Run B3.
2. **Unsubscribe the local app from the real WABA**, using the **local** token:

   ```bash
   curl -s -X DELETE "$GRAPH/<REAL_WABA_ID>/subscribed_apps" -H "Authorization: Bearer $TOKEN"
   ```

3. **Production publishes.** On the VM, open the agent → **Publish**. n8n registers the DuckDNS
   callback on app 1755….
4. **Subscribe the production app to the real WABA**, using the **production** token:

   ```bash
   curl -s -X POST "https://graph.facebook.com/v21.0/<REAL_WABA_ID>/subscribed_apps" -H "Authorization: Bearer <PROD_TOKEN>"
   curl -s "https://graph.facebook.com/v21.0/<REAL_WABA_ID>/subscribed_apps" -H "Authorization: Bearer <PROD_TOKEN>"
   # expect 1755561068820381 and NOT 1452204086838529
   ```

5. **Diagnose on the VM:**

   ```bash
   cd ~/smilecare-n8n
   export APP_ID=1755561068820381 APP_SECRET='<prod app secret>' WABA_ID='<REAL_WABA_ID>' \
          ACCESS_TOKEN='<PROD_TOKEN>' PHONE_NUMBER_ID='<REAL_PHONE_NUMBER_ID>' \
          PUBLIC_URL='https://smilecare-n8n.duckdns.org'
   python3 scripts/diagnose-whatsapp-webhook.py
   ```

   All stages should PASS. Fix the earliest FAIL first.
6. **Optional tidy-up.** App 1755… is also subscribed to the **test** WABA. Production's guard
   already drops test-number messages, but you can unsubscribe it with
   `curl -X DELETE "…/1628386515555176/subscribed_apps" -H "Authorization: Bearer <PROD_TOKEN>"`.

### D5. Production tests
Repeat Part C tests 3, 4 and 7–13 against production:
- Execution logs are on `https://smilecare-n8n.duckdns.org`.
- Data is in cloud Supabase. Use the dashboard, or the PostgREST curl with the cloud URL and
  key.
- Use a booking you then cancel, so no test data is left behind.

### D6. Templates and notifications in production
- Create the templates (A10) in the **real WABA**, if you haven't already.
- For reminders and notifications to arbitrary patients, plan the `Send Notification` →
  **Send Template** follow-up (see the A10 note).
- **Only message patients who opted in.** For example, add a consent line to booking
  confirmations or intake forms.

### D7. Monitoring
- **n8n → Executions**: filter by *Error* daily at first. The **WhatsApp Booking Error Handler**
  emails the admin on workflow errors, if SMTP is configured on the VM.
- **WhatsApp Manager → Phone numbers**: quality rating (GREEN / YELLOW / RED), messaging limit,
  and name status. **WhatsApp Manager → Insights**: messages and costs.
- **Developer alerts and email**: payment failures, quality drops, template rejections.
- **`diagnose-whatsapp-webhook.py`** after any Meta, credential or env change.
- Weekly: `python3 scripts/verify-whatsapp-token.py --no-send` (with the prod values exported).

### D8. Rollback
- **Workflow**: re-import the previous JSON into the same workflow. Backups are in `backups/`
  and in the VM volume backup.
- **Number routing**:
  1. Unsubscribe 1755… from the real WABA.
  2. Re-subscribe 1452… (A7).
  3. Put the real ID back into the local allowlist and run B3.
- **Credentials**: restore the old values in the two credentials, unpublish, then publish again.

---

## 8. Required IDs, permissions, credentials and env vars

| Name | Example / where to find it | Secret? | Stored in |
|---|---|---|---|
| Real Phone Number ID | API Setup → From → Phone number ID | no | `.env.docker` / VM `.env` (`WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ALLOWED_PHONE_NUMBER_IDS`) |
| Real WABA ID | API Setup / WhatsApp Manager | no | `WHATSAPP_BUSINESS_ACCOUNT_ID` → *WhatsApp account* credential |
| Test Phone Number ID / WABA | `1296266210241103` / `1628386515555176` | no | local TEST profile |
| Local App ID | `1452204086838529` | no | `WHATSAPP_CLIENT_ID` (local) → *WhatsApp OAuth account* |
| Prod App ID | `1755561068820381` | no | prod *WhatsApp OAuth account* |
| App Secret (per app) | App settings → Basic → Show | **yes** | `WHATSAPP_CLIENT_SECRET` (gitignored env) / n8n credential / password manager |
| System User token (per app) | Business settings → System users → Generate token | **yes** | `WHATSAPP_ACCESS_TOKEN` (gitignored env) / n8n credential / password manager |
| Token permissions | `whatsapp_business_messaging`, `whatsapp_business_management` | — | set when generating the token |
| System User asset access | WABA: Full control; App: Manage app | — | Business settings |
| Two-step verification PIN | chosen by you in A6 | **yes** | password manager only |
| Verify token | `4d182743-5c30-44b2-8bb7-b346135a7e70` (trigger node id) | no | automatic |
| Webhook path | `/webhook/e60f653f-a2f6-4686-909b-f3cca62cad2c/webhook` | no | automatic |
| Patient test number | your personal phone, `92…` without `+` | personal data | `WHATSAPP_TEST_RECIPIENT` (gitignored env) |
| Other env (unchanged) | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`, `CLINIC_TIMEZONE`, `WEBHOOK_URL` | key = yes | env files |

Gitignored (never commit): `.env`, `.env.docker`, `.env.meta`, `deploy/.env`,
`config/credentials-overwrite.json`.

---

## 9. Manual Meta actions checklist

**For local testing:**
- [ ] A1: confirm the business portfolio details
- [ ] A2: add a payment method in Billing Hub (also clears `141006` on the test WABA)
- [ ] A3: add the SIM's number in API Setup, create a **new** WABA, set the display name and category, verify by SMS / call
- [ ] A4: copy `<REAL_PHONE_NUMBER_ID>` and `<REAL_WABA_ID>`
- [ ] A5: assign the new WABA to the System User (Full control)
- [ ] A6: register the number with your new 6-digit PIN (store the PIN)
- [ ] A7: subscribe app 1452… to the new WABA
- [ ] A8: display name approved or available
- [ ] A10: submit utility templates (English and Urdu)
- [ ] A11: set the local app to Live **only if** real-number webhooks don't arrive

**For production:**
- [ ] A9: business verification (recommended)
- [ ] D1: prod app 1755…: App Secret, Live mode, System User token for that app, asset access
- [ ] D3: update the prod n8n credentials (in the VM UI)
- [ ] D4 steps 2 and 4: change the WABA `subscribed_apps`

---

## 10. Troubleshooting

### Meta API / delivery errors

| Code / symptom | Meaning | Fix |
|---|---|---|
| `131030` | Recipient not in allowed list | Test number only: add your phone in **API Setup → To → Manage phone number list** (max 5) |
| `131047` | Re-engagement: more than 24 h since the patient's last message | Use an approved template, or ask the patient to message first |
| `131026` | Message undeliverable | The recipient isn't on WhatsApp, has an old app, or hasn't accepted the terms. Check the number format (`92…`, no `+`, no leading `0`) |
| `131005` / `200` / `10` | Permission denied | The token can't access that number or WABA. Do A5 (assign the asset), then check `verify-whatsapp-token.py --no-send` |
| `100` | Invalid parameter / unknown ID | Wrong Phone Number ID or WABA ID, or an ID from another WABA |
| `190` | Token expired or invalid | Generate a System User token with expiry **Never**, update `.env.docker` and the n8n credential |
| `131042`, `141006` | Payment / eligibility problem | Fix the payment method in Billing Hub (A2) |
| `141010` | Business not verified (LIMITED) | Works within limits. Do A9 to scale |
| `133010` | Phone number not registered | Do A6 |
| `133005` | Two-step PIN mismatch | Use the existing PIN, or reset it in **WhatsApp Manager → Phone numbers → Two-step verification** |
| `133016` | Too many register / deregister calls (10 per 72 h) | Wait 72 h. Don't retry in loops |
| `136024` | Number already verified | Skip `request_code`. Go to A6 |
| `2388012` | Number already present in your WhatsApp account | It's already added. Find it under Phone numbers, don't re-add it |
| `132001` | Template does not exist | Wrong name or language, or the template is in another WABA (templates are per WABA) |
| `132000` | Template parameter count mismatch | Send exactly as many `{{n}}` values as the template defines |
| `131056` | Too many messages to the same user too fast | Slow down and retry later |
| `131031`, `368` | Account locked or restricted for policy | Check WhatsApp Manager and Business Support Home for the violation, then appeal |
| Number "already registered with WhatsApp" when adding | The SIM was used with a WhatsApp app | Delete that WhatsApp account in the app (consequences in §3), wait a few minutes, retry |

### Webhook / n8n issues

| Symptom | Cause | Fix |
|---|---|---|
| Publish fails: "*The WhatsApp App ID … already has a webhook subscription*" | Meta still has an old callback URL (old tunnel, or the other environment) | Point Meta at the current URL: **App Dashboard → WhatsApp → Configuration → Edit**, set the current callback URL and verify token → Verify and save, then Publish. Or delete the subscription: `read -rsp "App secret: " S; echo; curl -s -X DELETE "https://graph.facebook.com/v21.0/<APP_ID>/subscriptions?object=whatsapp_business_account&access_token=<APP_ID>%7C$S"; unset S`, then Publish |
| Real number's messages never reach n8n | WABA not subscribed to the app, number not registered, or app in Development mode | Check `GET /<REAL_WABA_ID>/subscribed_apps` (A7) and `status: CONNECTED` (A6), then try A11 |
| Meta reports webhook errors / GET or POST returns 404 | Agent not published, or the tunnel died | Re-run B3. Check `curl <WEBHOOK_URL>healthz` |
| Meta gets 200 but **no execution** | App Secret in *WhatsApp OAuth account* ≠ the secret of the app that owns the subscription | Re-save the credential with the right app's secret. `diagnose-whatsapp-webhook.py` stage 3 |
| Execution stops at **Allowed Business Number?** | That number isn't in `WHATSAPP_ALLOWED_PHONE_NUMBER_IDS` | Fix the env var, then B3 (or `up -d` on the VM) |
| Reply comes **from the test number** | Old workflow still loaded (hardcoded sender) | Do B2. Check that *Send WhatsApp Reply → Phone Number ID* is an expression |
| Reply node green but nothing arrives | Accepted but not delivered (`131047` / `131026`) | Patient must message first, or use a template. Check the patient's number format |
| Voice notes fail | Token can't read media on the new WABA | Do A5. Check that the *Get WhatsApp Audio* error is a permission error |
| Every message answered twice | Two environments answer the same number | Allowlists overlap and both apps are subscribed to the WABA. Follow D4 |
| Tunnel URL changed and messages stopped | Meta still calls the old URL | B3 (unpublish → script → publish) |

---

## 11. Costs and eligibility

**Pricing model (Meta, effective 1 Oct 2026):**
- Charges are **per delivered message**, by category (marketing / utility / authentication /
  service) and by the recipient's country.
- **Messages from patients to you are free.**
- **Service messages** (the agent's free-form replies inside the 24 h window):
  - Each business number gets **1,000 free per month**.
  - Beyond that they are charged at the **utility rate**. This changed on 1 Oct 2026.
  - Eligible government and non-profit organizations are exempt.
- **Utility templates** (confirmations, reminders) are charged at the utility rate, even inside
  an open window. Inside-window utility messages were free before 1 Oct 2026.
- **Marketing** templates cost more. **Authentication** templates are charged too.
- **Free entry point**: if a patient starts the chat from a Click-to-WhatsApp ad, all messages
  are free for up to 7 days (mobile app only).
- **Payment method required.** Without one, messages beyond the free tier are **not
  delivered**. The test WABA currently shows a payment error (`141006`).
- **Pakistan rates**: Meta raised Pakistan's utility and authentication rates on 1 Apr 2026 and
  again on 1 Oct 2026; the marketing rate is unchanged. Third-party sites quote about **US$0.015
  per utility / service message** and about **US$0.047 per marketing message**. Those figures
  are **unverified**, so check the official rate card linked from Meta's pricing page before
  budgeting.
- **Illustrative only** (at about $0.015 per message):
  - 300 patients a month × 6 replies = 1,800 service messages. 1,000 are free, so 800 are
    billed: about $12.
  - 300 reminder templates: about $4.50.
- No Meta platform fee for Cloud API. Other costs: the SIM, Groq usage, and hosting (the Oracle
  free tier).

**Eligibility and limits:**
- Messaging limit: **250** unique users per 24 h outside service windows, at **portfolio**
  level and shared by all numbers. Replies inside the window don't count.
  - To reach **2,000**: business verification, or 2,000 high-quality template deliveries in
    30 days.
  - Above that, Meta scales the limit automatically with quality.
- Numbers per portfolio: **2** until the business is verified or reaches the 2,000 limit, then
  **20**.
- Templates per WABA: **250** while unverified. **6,000** once verified with an approved display
  name.
- The display name must be approved or available (A8).
- Policy:
  - Follow the WhatsApp Business Messaging Policy.
  - Get patient **opt-in** before you message them first.
  - Keep medical details out of templates.
  - Expect blocks and reports to lower your quality rating.

---

## 12. End-to-end confirmation checklist

**Local:**
- [ ] `npm run test:whatsapp` passes
- [ ] `verify-whatsapp-token.py --no-send`: sender = clinic number, `CONNECTED`, name approved or available, no WABA health errors
- [ ] `GET /<REAL_WABA_ID>/subscribed_apps` shows the local app
- [ ] Inbound `hi` → execution with `phone_number_id = <REAL_PHONE_NUMBER_ID>`
- [ ] AI reply received **from the clinic number** with the right display name
- [ ] Book / get / reschedule / cancel / cancel-all over WhatsApp → rows change in Supabase and in the dashboard
- [ ] Voice note transcribed and answered
- [ ] Guard drops a number that isn't allowed; the test number still answers from the test number
- [ ] No unexpected errors in Executions or `docker logs n8n`

**Production (after approval):**
- [ ] Prod token `debug_token` → app 1755…, SYSTEM_USER, never expires
- [ ] Real WABA `subscribed_apps` = 1755… only
- [ ] `diagnose-whatsapp-webhook.py` on the VM: no FAIL
- [ ] Inbound → prod execution → reply from the clinic number
- [ ] Booking appears in cloud Supabase and on the Vercel dashboard
- [ ] Templates approved; payment method active; quality GREEN

---

## Sources (Meta official, checked 2026-10-21)
- [Pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing)
- [Register a business phone number](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/registration/)
- [Business phone numbers](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers)
- [Messaging limits](https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits)
- [Onboard WhatsApp Business app users (coexistence)](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users/)
- [Migrate an existing WhatsApp number](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/migrate-existing-whatsapp-number-to-a-business-account)
- [Webhooks](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks/)
- [Error codes](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes)
