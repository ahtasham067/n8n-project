#!/usr/bin/env python3
"""Update n8n WhatsApp credentials from .env.docker / .env."""

from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from n8n_crypto import decrypt_n8n, encrypt_n8n  # noqa: E402


def load_env() -> dict[str, str]:
    data: dict[str, str] = {}
    for name in (".env", ".env.docker"):
        path = ROOT / name
        if not path.exists():
            continue
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            value = value.strip().strip('"').strip("'")
            if value.startswith("your-"):
                continue
            data[key.strip()] = value
    return data


def docker_n8n_running() -> bool:
    result = subprocess.run(
        ["docker", "ps", "--filter", "name=^n8n$", "--format", "{{.Names}}"],
        capture_output=True,
        text=True,
        check=False,
    )
    return result.stdout.strip() == "n8n"


def stop_n8n() -> None:
    if docker_n8n_running():
        print("Stopping n8n before credential update...")
        subprocess.run(["docker", "stop", "n8n"], check=True)


def start_n8n() -> None:
    if docker_n8n_running():
        return
    print("Starting n8n...")
    subprocess.run(["docker", "start", "n8n"], check=True)
    for _ in range(60):
        result = subprocess.run(
            ["curl", "-sf", "http://127.0.0.1:5678/healthz"],
            capture_output=True,
            check=False,
        )
        if result.returncode == 0:
            return
        time.sleep(1)
    raise SystemExit("FAIL: n8n did not become healthy after credential update.")


def drop_stale_wal() -> None:
    """The database copied back already contains the old WAL. Delete that WAL in
    the volume, or SQLite would replay it over the updated file on the next start."""
    image = subprocess.run(
        ["docker", "inspect", "n8n", "--format", "{{.Config.Image}}"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    subprocess.run(
        [
            "docker", "run", "--rm", "--volumes-from", "n8n", "--entrypoint", "rm", image,
            "-f", "/home/node/.n8n/database.sqlite-wal", "/home/node/.n8n/database.sqlite-shm",
        ],
        check=True,
    )


def update_credential(
    cur: sqlite3.Cursor,
    encryption_key: str,
    cred_type: str,
    fields: dict[str, str],
) -> bool:
    cur.execute(
        "SELECT id, name, data FROM credentials_entity WHERE type = ? LIMIT 1",
        (cred_type,),
    )
    row = cur.fetchone()
    if not row:
        print(f"WARN: no {cred_type} credential found — create it once in n8n UI.")
        return False

    cred_id, cred_name, encrypted = row
    payload = json.loads(decrypt_n8n(encrypted, encryption_key))
    payload.update(fields)
    new_encrypted = encrypt_n8n(json.dumps(payload), encryption_key)
    cur.execute(
        "UPDATE credentials_entity SET data = ?, updatedAt = datetime('now') WHERE id = ?",
        (new_encrypted, cred_id),
    )
    print(f"Updated {cred_name!r} ({cred_type}, id={cred_id})")
    return True


def main() -> int:
    env = load_env()
    token = env.get("WHATSAPP_ACCESS_TOKEN", "").strip()
    business_account_id = env.get("WHATSAPP_BUSINESS_ACCOUNT_ID", "").strip()
    client_id = env.get("WHATSAPP_CLIENT_ID", "").strip()
    client_secret = env.get("WHATSAPP_CLIENT_SECRET", "").strip()

    if not token or token.startswith("your-"):
        print("FAIL: set WHATSAPP_ACCESS_TOKEN in .env.docker (System User token, not placeholder).")
        return 1
    if not business_account_id:
        print("FAIL: set WHATSAPP_BUSINESS_ACCOUNT_ID in .env.docker")
        return 1

    if subprocess.run(
        ["docker", "ps", "-a", "--filter", "name=^n8n$", "--format", "{{.Names}}"],
        capture_output=True,
        text=True,
    ).stdout.strip() != "n8n":
        print("FAIL: n8n container not found. Run ./start-n8n-whatsapp.sh first.")
        return 1

    stop_n8n()

    # Private temp dir: the copies hold every credential and the encryption key.
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "database.sqlite"
        cfg_path = Path(tmp) / "config"
        # n8n's latest writes can still be in the WAL after it stops, so copy it
        # too. Without it this would edit, and put back, a stale database.
        for suffix in ("", "-wal", "-shm"):
            subprocess.run(
                ["docker", "cp", f"n8n:/home/node/.n8n/database.sqlite{suffix}", f"{db_path}{suffix}"],
                check=not suffix,
                capture_output=bool(suffix),
            )
        subprocess.run(["docker", "cp", "n8n:/home/node/.n8n/config", str(cfg_path)], check=True)
        encryption_key = json.loads(cfg_path.read_text())["encryptionKey"]

        conn = sqlite3.connect(db_path)
        cur = conn.cursor()
        updated = update_credential(
            cur,
            encryption_key,
            "whatsAppApi",
            {
                "accessToken": token,
                "businessAccountId": business_account_id,
            },
        )
        if client_id and client_secret:
            update_credential(
                cur,
                encryption_key,
                "whatsAppTriggerApi",
                {
                    "clientId": client_id,
                    "clientSecret": client_secret,
                },
            )
        conn.commit()
        # Fold the WAL into the file so the copy below is complete on its own.
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.close()

        if not updated:
            return 1

        subprocess.run(["docker", "cp", str(db_path), "n8n:/home/node/.n8n/database.sqlite"], check=True)
    drop_stale_wal()
    print("Credentials synced from .env.docker into n8n database.")
    start_n8n()
    print("n8n restarted. Credential fields are visible under n8n → Credentials.")
    print("Send a NEW WhatsApp message to test — do not retry old failed executions.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
