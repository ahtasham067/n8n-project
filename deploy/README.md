# SmileCare n8n — cloud / testing deploy

Configs for the zero-cost Oracle + DuckDNS + Caddy setup described in the sibling dashboard repo:

`../Dentalclinic-dashboard/DEPLOYMENT.md`

| File | Purpose |
| --- | --- |
| `docker-compose.prod.yml` | n8n **2.34.6** on `127.0.0.1:5678` + Caddy on 80/443 |
| `Caddyfile` | Auto TLS reverse proxy (edit hostname) |
| `.env.production.example` | Copy to `.env` on the VM — **never set `N8N_ENCRYPTION_KEY`** |
| `migrate-n8n-volume.sh` | Export / upload / restore `n8n_data` volume |

**Local development** still uses `../docker-compose.yml` and `../start-n8n-whatsapp.sh`. Do **not** run the tunnel script on the cloud VM.

**Do not re-import** the nine workflow JSON files as the primary migration path — copy the volume so hardcoded sub-workflow IDs and encrypted credentials stay intact.
