#!/usr/bin/env python3
"""Build n8n CREDENTIALS_OVERWRITE_DATA JSON from local .env.

Workflow JSON files only store credential id/name/type. They cannot hold
secrets, and n8n will not read WHATSAPP_ACCESS_TOKEN= from those files.
This script maps .env values onto n8n credential-type fields so a local
n8n process can load them via CREDENTIALS_OVERWRITE_DATA.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENV_PATH = ROOT / ".env"
OUTPUT_PATH = ROOT / "config" / "credentials-overwrite.json"

REQUIRED = [
    "WHATSAPP_ACCESS_TOKEN",
    "WHATSAPP_BUSINESS_ACCOUNT_ID",
    "WHATSAPP_CLIENT_ID",
    "WHATSAPP_CLIENT_SECRET",
    "OPENAI_API_KEY",
    "SMTP_USER",
    "SMTP_PASSWORD",
    "SMTP_HOST",
    "SMTP_PORT",
]


def load_env(path: Path) -> dict[str, str]:
    if not path.exists():
        sys.exit(f"Missing {path}. Copy .env.example to .env and fill in values.")

    data: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        data[key] = value
    return data


def as_bool(value: str, default: bool = True) -> bool:
    if value == "":
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def main() -> None:
    env = load_env(ENV_PATH)
    missing = [key for key in REQUIRED if not env.get(key)]
    if missing:
        sys.exit("Missing required .env values: " + ", ".join(missing))

    try:
        smtp_port = int(env["SMTP_PORT"])
    except ValueError:
        sys.exit("SMTP_PORT must be a number, for example 465.")

    payload = {
        "whatsAppApi": {
            "accessToken": env["WHATSAPP_ACCESS_TOKEN"],
            "businessAccountId": env["WHATSAPP_BUSINESS_ACCOUNT_ID"],
        },
        "whatsAppTriggerApi": {
            "clientId": env["WHATSAPP_CLIENT_ID"],
            "clientSecret": env["WHATSAPP_CLIENT_SECRET"],
        },
        "openAiApi": {
            "apiKey": env["OPENAI_API_KEY"],
        },
        "smtp": {
            "user": env["SMTP_USER"],
            "password": env["SMTP_PASSWORD"],
            "host": env["SMTP_HOST"],
            "port": smtp_port,
            "secure": as_bool(env.get("SMTP_SECURE", "true")),
        },
    }

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(payload, separators=(",", ":")))
    print(f"Wrote {OUTPUT_PATH}", file=sys.stderr)


if __name__ == "__main__":
    main()
