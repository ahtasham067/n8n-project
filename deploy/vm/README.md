# Deploying workflows to the Oracle VM from GitHub Actions

`.github/workflows/deploy.yml` deploys main to production n8n over SSH:

1. **Checks:** every `ci.yml` job, run again on the merged commit.
2. **Approval:** the job waits in the `production-vm` environment until you approve it.
3. **SSH:** the key can only run `ssh-gate.sh`. The gate fetches main, refuses any commit that isn't on it, checks the commit out in `~/clinidesk-n8n-repo`, and runs `deploy.sh`.
4. **`deploy.sh`:**
   - Exports every workflow and credential (credentials stay encrypted).
   - Refuses if a workflow being deployed uses a credential id production lacks. Nothing has changed at that point.
   - Stops n8n and archives the `n8n_data` volume.
   - Imports the files in `workflows.txt` by their fixed ids, so existing workflows are updated in place and keep their ids.
   - Publishes those workflows, plus everything that was published before.
   - Starts n8n and checks `/healthz/readiness` and that every id is published.
   - On any failure after the stop, puts the archived volume back and starts n8n again.

`rollback.yml` uses the same key and approval to run `rollback.sh` with a backup id, `latest` or `status`.

What it never does:
- Import, decrypt or print credentials.
- Touch Caddy or `.env`.
- Run `down -v`.
- Change the n8n image tag.

Logs show counts and ids only, because this repo is public and so are its Actions logs.

## When deploys run

- **A push to main** deploys only when the repo variable `AUTO_DEPLOY_PRODUCTION` is `true`. Leave it unset until the SaaS cutover: main's workflows need the SaaS dashboard (gateway, LLM proxy, `bot_*` RPCs), and production still runs the pre-SaaS ones.
- **Run workflow** on Deploy always deploys main's head, after approval.

## One-time setup

All of this is done by hand, once. It is listed in the order to do it.

### 1. A key for GitHub Actions only (on your laptop)

```bash
ssh-keygen -t ed25519 -N "" -C "github-actions n8n deploy" -f ./clinidesk-n8n-deploy
```

The private half (`clinidesk-n8n-deploy`) goes into the GitHub secret `N8N_VM_SSH_KEY`. Delete the file from your laptop afterwards. The public half goes on the VM in step 3.

### 2. The gate and the repo checkout (on the VM, as `ubuntu`)

```bash
mkdir -p ~/bin ~/backups/n8n-deploy && chmod 700 ~/backups/n8n-deploy
git clone https://github.com/ahtasham067/n8n-project.git ~/clinidesk-n8n-repo
install -m 755 ~/clinidesk-n8n-repo/deploy/vm/ssh-gate.sh ~/bin/clinidesk-n8n-gate
command -v python3 flock curl git docker   # all five must exist
```

The scripts expect:
- `~/smilecare-n8n/docker-compose.prod.yml`
- a container named `n8n`
- the `n8n_data` volume
- `http://127.0.0.1:5678/healthz/readiness`

If the VM differs, put overrides (`N8N_APP_DIR`, `N8N_CONTAINER`, `N8N_VOLUME`, `N8N_HEALTH_URL`, `N8N_BACKUP_DIR`, `N8N_KEEP_BACKUPS`) in `~/.config/clinidesk-n8n-deploy.env`.

Copy the gate again whenever `deploy/vm/ssh-gate.sh` changes. `deploy.sh` and `rollback.sh` always come from the checkout.

### 3. Restrict the key (on the VM)

Add one line to `~/.ssh/authorized_keys`, with the public key from step 1:

```
command="/home/ubuntu/bin/clinidesk-n8n-gate",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAA... github-actions n8n deploy
```

Whatever a client sends, this key runs only the gate. Your own login key is unaffected.

### 4. The host key for GitHub (on your laptop)

```bash
ssh-keyscan -t ed25519 <VM host> 2>/dev/null
```

Compare it with the VM's own fingerprint (on the VM: `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`). If they match, the `ssh-keyscan` line is `N8N_VM_KNOWN_HOSTS`.

### 5. GitHub settings

**Environment secrets.** Settings → Environments → `production-vm` → Environment secrets:

| Secret | Value |
| --- | --- |
| `N8N_VM_HOST` | The VM's public IP, or its DuckDNS name |
| `N8N_VM_USER` | `ubuntu` |
| `N8N_VM_SSH_KEY` | The private key from step 1 |
| `N8N_VM_KNOWN_HOSTS` | The line from step 4 |
| `N8N_VM_PORT` | Optional; 22 when unset |

**Environment settings.** The `production-vm` environment has you as its required reviewer, and only `main` may deploy to it.

**Repo variable.** `AUTO_DEPLOY_PRODUCTION` = `true` only after the SaaS cutover.

### 6. Credentials with fixed ids

The workflows reference credentials by id. Before the first deploy, production needs:
- `CliniDeskLlmProxy`: OpenAI type, named "CliniDesk LLM proxy"; its API key is `CLINIDESK_GATEWAY_SECRET`. New with the SaaS release.
- `m3V5iKCzv82oBoW9`: SMTP, used by the error handler.

`deploy.sh` stops with "no credential with id …" if one is missing. The n8n UI can't choose an id, so create a missing one on the VM from a temporary file:

```bash
docker exec -i n8n sh -c 'umask 077; cat > /tmp/c.json && n8n import:credentials --input=/tmp/c.json; rm -f /tmp/c.json' <<'JSON'
[{"id":"CliniDeskLlmProxy","name":"CliniDesk LLM proxy","type":"openAiApi","data":{"apiKey":"<CLINIDESK_GATEWAY_SECRET>"}}]
JSON
```

Type the value in place of `<…>`. Don't leave it in shell history: start the command with a space when `HISTCONTROL=ignorespace`.

## Backups and rollback

- **What a backup holds:** each deploy writes `~/backups/n8n-deploy/<UTC time>-<commit>/`:
  - `n8n_data.tar.gz`: the whole volume, taken just before anything changed;
  - `workflows.json` and `credentials.json`: the export, with credentials still encrypted;
  - `published-before.txt`.
- **Access and retention:** the files are mode 600, and the newest 10 backups are kept.
- **To roll back:** Actions → Rollback → Run workflow:
  - `latest` undoes the last deploy;
  - a backup id goes back to just before that deploy;
  - `status` lists the backups.
- **What a rollback restores:** the whole volume, so executions and credential edits made since that backup go back too.
- **By hand on the VM:** `bash ~/clinidesk-n8n-repo/deploy/vm/rollback.sh <id|latest|list>`.

## Simulating it locally

You can test the scripts against a throwaway n8n:
1. Write a compose file with another container name, volume and port.
2. Point the `N8N_*` overrides at it.
3. Run `deploy.sh` from a clone checked out at the commit.

Never point them at your local `n8n` container or its `n8n_data` volume.
