#!/usr/bin/env python3
"""Locate the exact layer where a WhatsApp webhook stops reaching n8n.

Run this ON THE ORACLE VM (stdlib only — no pip installs needed).

    export APP_ID=...            # Meta App ID        (App settings -> Basic)
    export APP_SECRET=...        # Meta App Secret    (App settings -> Basic, "Show")
    export WABA_ID=...           # WhatsApp Business Account ID
    export ACCESS_TOKEN=...      # System User token (whatsapp_business_management)
    export PUBLIC_URL=https://YOUR-N8N-HOST/
    export PHONE_NUMBER_ID=...   # sender Phone Number ID (WHATSAPP_PHONE_NUMBER_ID)
    python3 scripts/diagnose-whatsapp-webhook.py

Secrets are never printed — only 8-char fingerprints, so you can compare what
Meta has against what n8n has without exposing either.

Every probe is read-only. Nothing is created, activated, or deleted.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

GRAPH = "https://graph.facebook.com/v21.0"

# From "WhatsApp AI Appointment Booking Agent.json". Override if the VM's copy
# differs (n8n UI -> WhatsApp Trigger -> Production URL shows the real values).
WEBHOOK_ID = os.environ.get("WEBHOOK_ID", "e60f653f-a2f6-4686-909b-f3cca62cad2c")
NODE_ID = os.environ.get("NODE_ID", "4d182743-5c30-44b2-8bb7-b346135a7e70")
N8N_BASE = os.environ.get("N8N_BASE", "http://127.0.0.1:5678").rstrip("/")

PASS, FAIL, WARN, INFO = "PASS", "FAIL", "WARN", "INFO"
_verdicts: list[tuple[str, str, str]] = []


def note(status: str, stage: str, message: str) -> None:
    _verdicts.append((status, stage, message))
    print(f"  [{status}] {message}")


def heading(text: str) -> None:
    print(f"\n{text}\n{'-' * len(text)}")


def fingerprint(value: str) -> str:
    if not value:
        return "(unset)"
    return hashlib.sha256(value.encode()).hexdigest()[:8]


def http(
    url: str,
    *,
    method: str = "GET",
    body: bytes | None = None,
    headers: dict[str, str] | None = None,
    timeout: int = 20,
) -> tuple[int, str]:
    """Return (status, body). Never raises on HTTP error status."""
    req = urllib.request.Request(url, data=body, headers=headers or {}, method=method)
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")
    except Exception as exc:  # noqa: BLE001 - surface DNS/TLS/refused as one line
        return 0, f"{type(exc).__name__}: {exc}"


def sample_payload(waba_id: str) -> str:
    """A minimal but structurally real Meta 'messages' webhook body."""
    return json.dumps(
        {
            "object": "whatsapp_business_account",
            "entry": [
                {
                    "id": waba_id or "0",
                    "changes": [
                        {
                            "field": "messages",
                            "value": {
                                "messaging_product": "whatsapp",
                                "metadata": {
                                    "display_phone_number": "0",
                                    "phone_number_id": "0",
                                },
                                "contacts": [
                                    {
                                        "profile": {"name": "Webhook Diagnostic"},
                                        "wa_id": "920000000000",
                                    }
                                ],
                                "messages": [
                                    {
                                        "from": "920000000000",
                                        "id": "wamid.diagnostic",
                                        "timestamp": "0",
                                        "type": "text",
                                        "text": {"body": "diagnostic ping"},
                                    }
                                ],
                            },
                        }
                    ],
                }
            ],
        },
        separators=(",", ":"),
    )


# --------------------------------------------------------------------------
# Stage 1 — is n8n up, is the workflow active, is the trigger routed?
# --------------------------------------------------------------------------
def stage_n8n_local() -> None:
    heading("Stage 1 — n8n container (loopback, bypasses Caddy)")

    status, _ = http(f"{N8N_BASE}/healthz")
    if status == 200:
        note(PASS, "n8n", f"n8n answers on {N8N_BASE}/healthz")
    else:
        note(FAIL, "n8n", f"{N8N_BASE}/healthz returned {status or 'no connection'} — n8n is down or on another port")
        return

    url = f"{N8N_BASE}/webhook/{WEBHOOK_ID}/webhook"
    status, _ = http(url, method="POST", body=b"{}", headers={"Content-Type": "application/json"})
    if status == 404:
        note(
            FAIL,
            "n8n",
            "POST to the production webhook path returned 404 — the workflow is NOT ACTIVE, "
            "or this VM's webhookId differs. Nothing Meta sends can ever produce an execution.",
        )
    elif status == 200:
        note(PASS, "n8n", "Production webhook path is registered (unsigned POST -> 200, silently dropped as expected)")
    else:
        note(WARN, "n8n", f"Unexpected status {status} on the webhook path")


# --------------------------------------------------------------------------
# Stage 2 — verify token (Meta's GET challenge handshake)
# --------------------------------------------------------------------------
def stage_verify_token() -> None:
    heading("Stage 2 — Meta verification handshake (GET hub.challenge)")

    challenge = secrets.token_hex(8)
    query = urllib.parse.urlencode(
        {"hub.mode": "subscribe", "hub.challenge": challenge, "hub.verify_token": NODE_ID}
    )
    status, body = http(f"{N8N_BASE}/webhook/{WEBHOOK_ID}/webhook?{query}")

    if status == 404:
        note(FAIL, "verify", "404 — workflow inactive (see Stage 1). Meta's verification can never succeed.")
    elif body.strip() == challenge:
        note(PASS, "verify", f"n8n echoed the challenge. Verify token is confirmed as node id {NODE_ID}")
    else:
        note(
            FAIL,
            "verify",
            f"n8n did NOT echo the challenge (status {status}, body {body[:80]!r}). "
            f"The WhatsApp Trigger node id on this VM is not {NODE_ID} — read the real one from the n8n UI.",
        )


# --------------------------------------------------------------------------
# Stage 3 — App Secret: does n8n's stored secret match the app Meta signs with?
# --------------------------------------------------------------------------
def stage_signature(app_secret: str, waba_id: str) -> None:
    heading("Stage 3 — App Secret / X-Hub-Signature-256 (the silent-drop check)")

    if not app_secret:
        note(WARN, "signature", "APP_SECRET not set — skipping. This is the #1 cause of '200 OK but no execution'.")
        return

    payload = sample_payload(waba_id).encode()
    signature = hmac.new(app_secret.encode(), payload, hashlib.sha256).hexdigest()
    status, body = http(
        f"{N8N_BASE}/webhook/{WEBHOOK_ID}/webhook",
        method="POST",
        body=payload,
        headers={
            "Content-Type": "application/json",
            "X-Hub-Signature-256": f"sha256={signature}",
        },
    )

    note(INFO, "signature", f"App Secret fingerprint (Meta console value): {fingerprint(app_secret)}")

    if status == 404:
        note(FAIL, "signature", "404 — workflow inactive; cannot test the secret yet.")
    elif status == 200:
        note(
            INFO,
            "signature",
            "Signed POST accepted with HTTP 200. NOW OPEN n8n -> Executions:\n"
            "         - a new execution appeared  -> n8n and the App Secret are CORRECT; the fault is upstream (Stage 4/5/6).\n"
            "         - no execution appeared     -> n8n's stored App Secret does not match this one. Re-save the\n"
            "                                        'WhatsApp OAuth account' credential with the App Secret from Meta.",
        )
    else:
        note(WARN, "signature", f"Unexpected status {status}: {body[:120]}")


# --------------------------------------------------------------------------
# Stage 4 — where is Meta actually sending webhooks?
# --------------------------------------------------------------------------
def stage_app_subscription(app_id: str, app_secret: str, public_url: str) -> None:
    heading("Stage 4 — Meta app-level webhook subscription (where Meta POSTs)")

    if not (app_id and app_secret):
        note(WARN, "subscription", "APP_ID/APP_SECRET not set — skipping.")
        return

    token = urllib.parse.quote(f"{app_id}|{app_secret}", safe="")
    status, body = http(f"{GRAPH}/{app_id}/subscriptions?access_token={token}")
    if status != 200:
        note(FAIL, "subscription", f"Graph API returned {status}: {body[:200]}")
        return

    subs = json.loads(body).get("data", [])
    wa = [s for s in subs if s.get("object") == "whatsapp_business_account"]
    if not wa:
        note(
            FAIL,
            "subscription",
            "This Meta app has NO whatsapp_business_account webhook subscription. "
            "Meta is not sending anything anywhere. Fix: deactivate and reactivate the workflow in n8n.",
        )
        return

    expected = f"{public_url.rstrip('/')}/webhook/{WEBHOOK_ID}/webhook" if public_url else None
    for sub in wa:
        callback = sub.get("callback_url", "")
        fields = sorted(f.get("name") for f in sub.get("fields", []))
        note(INFO, "subscription", f"callback_url = {callback}")
        note(INFO, "subscription", f"active = {sub.get('active')}   fields = {', '.join(fields)}")

        if "messages" not in fields:
            note(FAIL, "subscription", "The 'messages' field is NOT subscribed — inbound messages are never sent.")
        if not sub.get("active"):
            note(FAIL, "subscription", "Subscription is INACTIVE — Meta disabled it after repeated delivery failures.")
        if "trycloudflare.com" in callback:
            note(
                FAIL,
                "subscription",
                "callback_url points at a Cloudflare quick tunnel (your LOCAL dev machine). "
                "Local and production share one Meta App ID, and the last activation wins. "
                "Production receives nothing until you reactivate the workflow on the VM.",
            )
        elif expected and callback.rstrip("/") != expected.rstrip("/"):
            note(FAIL, "subscription", f"callback_url does not match this VM. Expected: {expected}")
        elif expected:
            note(PASS, "subscription", "callback_url matches this VM's production webhook URL")


# --------------------------------------------------------------------------
# Stage 5 — is the WABA (and the new phone number) subscribed to the app?
# --------------------------------------------------------------------------
def stage_waba(waba_id: str, access_token: str) -> None:
    heading("Stage 5 — WABA subscription + phone numbers (run this after changing a number)")

    if not (waba_id and access_token):
        note(WARN, "waba", "WABA_ID/ACCESS_TOKEN not set — skipping.")
        return

    note(INFO, "waba", f"Access token fingerprint: {fingerprint(access_token)}")
    auth = {"Authorization": f"Bearer {access_token}"}

    status, body = http(f"{GRAPH}/{waba_id}/subscribed_apps", headers=auth)
    if status != 200:
        note(FAIL, "waba", f"subscribed_apps returned {status}: {body[:200]}")
    else:
        apps = json.loads(body).get("data", [])
        if not apps:
            note(
                FAIL,
                "waba",
                "This WhatsApp Business Account is subscribed to NO app. Meta generates no webhook events at all. "
                "Fix in Meta console: WhatsApp -> Configuration -> Webhook -> Manage/Subscribe.",
            )
        else:
            for app in apps:
                info = app.get("whatsapp_business_api_data", {})
                note(PASS, "waba", f"WABA is subscribed to app: {info.get('name')} (id {info.get('id')})")

    status, body = http(f"{GRAPH}/{waba_id}/phone_numbers?fields=id,display_phone_number,verified_name", headers=auth)
    if status != 200:
        note(WARN, "waba", f"phone_numbers returned {status}: {body[:200]}")
        return

    numbers = json.loads(body).get("data", [])
    if not numbers:
        note(FAIL, "waba", "This WABA has no phone numbers — the new number is registered under a DIFFERENT WABA.")
    for num in numbers:
        note(INFO, "waba", f"phone_number_id = {num.get('id')}   number = {num.get('display_phone_number')}")

    # Replies use the inbound metadata.phone_number_id; PHONE_NUMBER_ID is the fallback
    # sender and the Send Notification sender, so it must live on this WABA.
    expected = os.environ.get("PHONE_NUMBER_ID", "").strip()
    if not expected:
        note(WARN, "waba", "PHONE_NUMBER_ID not set — skipping the sender check (export WHATSAPP_PHONE_NUMBER_ID's value).")
    elif numbers and all(n.get("id") != expected for n in numbers):
        note(
            FAIL,
            "waba",
            f"PHONE_NUMBER_ID {expected} is not on WABA {waba_id}. Fix WHATSAPP_PHONE_NUMBER_ID / "
            "WHATSAPP_ALLOWED_PHONE_NUMBER_IDS in the env file, or WABA_ID points at the wrong account.",
        )
    elif numbers:
        note(PASS, "waba", f"PHONE_NUMBER_ID {expected} is on this WABA")


def main() -> int:
    app_id = os.environ.get("APP_ID", "").strip()
    app_secret = os.environ.get("APP_SECRET", "").strip()
    waba_id = os.environ.get("WABA_ID", "").strip()
    access_token = os.environ.get("ACCESS_TOKEN", "").strip()
    public_url = os.environ.get("PUBLIC_URL", "").strip()

    print("WhatsApp -> n8n webhook path diagnostic")
    print(f"  n8n base   : {N8N_BASE}")
    print(f"  webhookId  : {WEBHOOK_ID}")
    print(f"  node id    : {NODE_ID}  (this is Meta's verify token)")
    print(f"  public URL : {public_url or '(PUBLIC_URL unset)'}")
    if public_url:
        print(f"  expected callback: {public_url.rstrip('/')}/webhook/{WEBHOOK_ID}/webhook")

    if public_url:
        heading("Stage 0 — public reachability")
        status, _ = http(f"{public_url.rstrip('/')}/healthz")
        if status == 200:
            note(PASS, "public", "Public URL reaches n8n through Caddy (TLS + DNS + firewall all fine)")
        else:
            note(FAIL, "public", f"{public_url.rstrip('/')}/healthz returned {status or 'no connection'} — DNS, Oracle Security List, host firewall, or Caddy")

    stage_n8n_local()
    stage_verify_token()
    stage_signature(app_secret, waba_id)
    stage_app_subscription(app_id, app_secret, public_url)
    stage_waba(waba_id, access_token)

    heading("Summary")
    failures = [v for v in _verdicts if v[0] == FAIL]
    if failures:
        for _, stage, message in failures:
            print(f"  FAIL [{stage}] {message.splitlines()[0]}")
        print("\n  Fix the earliest stage first, then re-run.")
    else:
        print("  No hard failures. If messages still do not arrive, check the Stage 3 note about")
        print("  whether an execution actually appeared, then Meta -> Webhooks -> Recent Error Samples.")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
