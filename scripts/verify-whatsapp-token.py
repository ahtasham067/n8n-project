#!/usr/bin/env python3
"""Verify WhatsApp Cloud API token, sender number, and (optionally) a test send.

    python3 scripts/verify-whatsapp-token.py --no-send   # read-only checks
    python3 scripts/verify-whatsapp-token.py             # also sends one text message

Values come from the process env first, then .env / .env.docker:
    WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID (sender),
    WHATSAPP_BUSINESS_ACCOUNT_ID (optional, health check),
    WHATSAPP_TEST_RECIPIENT (patient-side number, required only for the send test).
"""

from __future__ import annotations

import argparse
import json
import os
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GRAPH = "https://graph.facebook.com/v21.0"


def load_setting(key: str) -> str:
    value = os.environ.get(key, "").strip()
    if value and not value.startswith("your-"):
        return value
    found = ""
    for name in (".env", ".env.docker"):
        path = ROOT / name
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.startswith(f"{key}="):
                continue
            value = line.split("=", 1)[1].strip().strip('"').strip("'")
            if value and not value.startswith("your-"):
                found = value
    return found


def get(url: str, token: str) -> dict:
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def post(url: str, token: str, body: dict) -> dict:
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--no-send", action="store_true", help="read-only: skip the test message")
    args = parser.parse_args()

    token = load_setting("WHATSAPP_ACCESS_TOKEN")
    phone_number_id = load_setting("WHATSAPP_PHONE_NUMBER_ID")
    waba_id = load_setting("WHATSAPP_BUSINESS_ACCOUNT_ID")
    recipient = load_setting("WHATSAPP_TEST_RECIPIENT")

    if not token:
        print("FAIL: WHATSAPP_ACCESS_TOKEN missing or still a placeholder.")
        print("Set it in n8n-project/.env.docker, then run: python3 scripts/apply-whatsapp-auth.py")
        return 1
    if not phone_number_id:
        print("FAIL: WHATSAPP_PHONE_NUMBER_ID missing — set the sender's Phone Number ID in .env.docker.")
        return 1

    print(f"Token length: {len(token)}")

    try:
        debug = get(f"{GRAPH}/debug_token?input_token={token}", token)["data"]
    except urllib.error.HTTPError as exc:
        print(f"FAIL: debug_token HTTP {exc.code}: {exc.read().decode()}")
        return 1

    print(f"Token type: {debug.get('type')}")
    print(f"Token app: {debug.get('application')} ({debug.get('app_id')})")
    print(f"Valid: {debug.get('is_valid')}")
    print(f"Expires at (unix): {debug.get('expires_at')}")
    print(f"Scopes: {', '.join(debug.get('scopes', []))}")

    if debug.get("type") == "USER":
        print("WARN: USER tokens expire in hours. Use a Meta Business System User token (Never expire).")

    fields = "display_phone_number,verified_name,name_status,code_verification_status,status,quality_rating,messaging_limit_tier,platform_type"
    try:
        phone = get(f"{GRAPH}/{phone_number_id}?fields={fields}", token)
    except urllib.error.HTTPError as exc:
        print(f"FAIL: cannot read phone number id {phone_number_id}: {exc.read().decode()}")
        print("      Is the WABA assigned to this System User (Business Settings → System users → Assign assets)?")
        return 1

    print(f"Sender: {phone.get('display_phone_number')} ({phone.get('verified_name')}), id {phone_number_id}")
    for key in ("status", "name_status", "code_verification_status", "quality_rating", "messaging_limit_tier", "platform_type"):
        print(f"  {key}: {phone.get(key)}")
    if phone.get("status") != "CONNECTED":
        print("WARN: number is not CONNECTED — register it: POST /{PHONE_NUMBER_ID}/register with your 6-digit PIN.")

    if waba_id:
        try:
            waba = get(f"{GRAPH}/{waba_id}?fields=name,health_status", token)
            health = waba.get("health_status", {})
            print(f"WABA: {waba.get('name')} ({waba_id}) can_send_message={health.get('can_send_message')}")
            for entity in health.get("entities", []):
                for err in entity.get("errors", []):
                    print(f"  WARN {entity.get('entity_type')} {err.get('error_code')}: {err.get('error_description')}")
        except urllib.error.HTTPError as exc:
            print(f"WARN: cannot read WABA {waba_id}: {exc.read().decode()}")

    if args.no_send:
        print("OK: read-only checks passed (--no-send).")
        return 0

    if not recipient:
        print("FAIL: WHATSAPP_TEST_RECIPIENT missing — set the patient-side number (not the business number),")
        print("      or re-run with --no-send.")
        return 1

    body = {
        "messaging_product": "whatsapp",
        "to": recipient,
        "type": "text",
        "text": {"body": "SmileCare token verification ping"},
    }
    try:
        result = post(f"{GRAPH}/{phone_number_id}/messages", token, body)
        print(f"Send test OK: message id {result.get('messages', [{}])[0].get('id', 'unknown')}")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode()
        print(f"FAIL: send test HTTP {exc.code}: {body}")
        if "131005" in body:
            print(
                "\nMeta rejected the token for sending. Generate a new System User token:\n"
                "  Meta Business Settings → Users → System users → Generate token\n"
                "  Select your WhatsApp Business Account + permissions:\n"
                "    whatsapp_business_messaging, whatsapp_business_management\n"
                "  Expiration: Never\n"
                "Then paste into .env.docker as WHATSAPP_ACCESS_TOKEN and run:\n"
                "  python3 scripts/apply-whatsapp-auth.py\n"
                "  ./scripts/start-n8n.sh"
            )
        return 1

    # Meta accepts free-form text even when it later fails to deliver it.
    print("NOTE: free-form text only DELIVERS if the recipient messaged this number in the last 24h")
    print("      (else webhook status 'failed' with 131047). Test number: recipient must be on the")
    print("      API Setup allowed list (else 131030).")
    print("OK: WhatsApp token can send messages.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
