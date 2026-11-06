# n8n-project

n8n workflows and scripts for the CliniDesk WhatsApp booking assistant. `CLAUDE.md` describes the architecture; `WHATSAPP_REAL_NUMBER_SETUP.md` has the full Meta and production walkthrough.

## WhatsApp numbers per environment

Local n8n uses **only Meta's test number**. Production n8n uses **only the real number**. No number, ID or token goes in git.

| | Local | Production (Oracle VM) |
|---|---|---|
| Env file (gitignored) | `.env.docker`, loaded by `docker-compose.yml`. `.env.meta` keeps the same test values for reference | `~/smilecare-n8n/.env`, loaded by `deploy/docker-compose.prod.yml` |
| `WHATSAPP_NUMBER_PROFILE` | `test` | `real` |
| `WHATSAPP_PHONE_NUMBER_ID` | Test number's ID | Real number's ID |
| `WHATSAPP_ALLOWED_PHONE_NUMBER_IDS` | Test number's ID only | Real number's ID only |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | Test WABA | Real WABA |
| Meta app and token | Local app, local System User | Production app, production System User |
| n8n credentials `WhatsApp account`, `WhatsApp OAuth account` | Local store, in the `n8n_data` volume | The VM's own store, in its `n8n_data` volume |

The credentials have the same names and IDs on both instances so the workflows resolve on each, but they live in separate encrypted stores and must hold different values. Never sync them from one instance to the other.

The tokens must not overlap either. Each Meta app subscribes to its own WABA only, and each System User is assigned its own WABA only. Check with the local token that the real number is out of reach:

```bash
read -rsp 'LOCAL token: ' TOKEN; echo
curl -s "https://graph.facebook.com/v21.0/<REAL_PHONE_NUMBER_ID>?fields=id" -H "Authorization: Bearer $TOKEN"
# expect an error (100 or 200)
```

### Guards

- **`./start-n8n-whatsapp.sh`** refuses to start unless the profile is `test` and Graph reports every allowlisted ID as a Meta test number.
- **`scripts/verify-whatsapp-token.py`** runs the same check, for either profile, before it sends anything. Add `--no-send` for a read-only check.
- **`Send Notification.json`** answers 403 and sends nothing unless `WHATSAPP_PHONE_NUMBER_ID` is in a non-empty allowlist.
- **`deploy/vm/deploy.sh`** refuses to deploy to a container whose profile isn't `real`.
- **The agent workflow** holds no WhatsApp credential. It sends through the dashboard, which has its own guard (`src/lib/whatsapp/number-guard.ts` in `Dentalclinic-dashboard`).

### Local setup

1. `cp .env.example .env.docker`, then fill in the test number's values.
2. **Check that the local Meta app isn't subscribed to the real WABA.** While it is, a running tunnel delivers real patients' messages to your laptop.
3. Run `./start-n8n-whatsapp.sh`. Never run it on the VM.

### Test scripts

`scripts/test-appointment-lifecycle.py` and `scripts/verify-shared-supabase-e2e.py` need the test patient's number:

```bash
E2E_TEST_PHONE=<digits, no +> python3 scripts/verify-shared-supabase-e2e.py
```
