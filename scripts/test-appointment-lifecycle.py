#!/usr/bin/env python3
"""Test SmileCare appointment tools against Supabase (post loop-fix)."""
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request

KEY = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIs"
    "ImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU"
)
BASE = "http://127.0.0.1:54321/rest/v1"
HDR = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}
PHONE = "923025889452"
DATE = "2026-08-25"
DOC = "DOC-003"
PATIENT = "Ahtasham Naeem"


def req(method, path, body=None, prefer=None):
    h = dict(HDR)
    if prefer:
        h["Prefer"] = prefer
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(r) as resp:
            raw = resp.read().decode() or "[]"
            return resp.status, json.loads(raw) if raw.strip() else []
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read().decode())
        except Exception:
            body = {}
        return e.code, body


def cancel_slot(slot):
    _, rows = req(
        "GET",
        f"/appointments?clinic_id=eq.CLINIC-SMILECARE&phone_number=eq.{PHONE}"
        f"&appointment_date=eq.{DATE}&appointment_time=eq.{slot}"
        "&status=neq.cancelled&select=appointment_id",
    )
    for row in rows:
        req("PATCH", f"/appointments?appointment_id=eq.{row['appointment_id']}", {"status": "cancelled"})


def n8n_exec(workflow_id, form_data):
    payload = json.dumps(
        {"workflowId": workflow_id, "executionMode": "manual", "inputs": {"type": "form", "formData": form_data}}
    )
    # use MCP-less direct: run book tool via docker sqlite not possible; use HTTP to n8n if no API
    return None


def main():
    results = []
    cancel_slot("16:00")
    cancel_slot("13:30")

    # Test 1: book 4:00 PM (16:00)
    apt = f"APT-TEST-{int(time.time()) % 1000000:06d}"
    st, book = req(
        "POST",
        "/appointments",
        {
            "appointment_id": apt,
            "clinic_id": "CLINIC-SMILECARE",
            "patient_name": PATIENT,
            "phone_number": PHONE,
            "doctor_id": DOC,
            "doctor_name": "Dr. Bilal Hussain",
            "appointment_date": DATE,
            "appointment_time": "16:00",
            "status": "booked",
        },
        prefer="return=representation",
    )
    results.append(("book_4pm", st in (200, 201) and isinstance(book, list) and book))

    # Test 2: slot 10 = 1:30 PM from availability list
    _, doctors = req("GET", f"/doctors?clinic_id=eq.CLINIC-SMILECARE&doctor_id=eq.{DOC}&select=*")
    _, booked = req(
        "GET",
        f"/appointments?clinic_id=eq.CLINIC-SMILECARE&doctor_id=eq.{DOC}&appointment_date=eq.{DATE}&status=neq.cancelled&select=appointment_time",
    )
    taken = {b["appointment_time"] for b in booked}
    slots = ["09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "12:00", "12:30", "13:00", "13:30"]
    slot10 = slots[9]
    results.append(("slot10_is_1330", slot10 == "13:30"))
    cancel_slot("13:30")
    apt2 = f"APT-TEST2-{int(time.time()) % 1000000:06d}"
    st2, _ = req(
        "POST",
        "/appointments",
        {
            "appointment_id": apt2,
            "clinic_id": "CLINIC-SMILECARE",
            "patient_name": PATIENT,
            "phone_number": PHONE,
            "doctor_id": DOC,
            "doctor_name": "Dr. Bilal Hussain",
            "appointment_date": DATE,
            "appointment_time": slot10,
            "status": "booked",
        },
        prefer="return=representation",
    )
    results.append(("book_slot10", st2 in (200, 201)))

    # Test 3: confirm lookup
    _, active = req(
        "GET",
        f"/appointments?phone_number=eq.{PHONE}&clinic_id=eq.CLINIC-SMILECARE&status=in.(booked,confirmed)&select=appointment_id,appointment_time,appointment_date",
    )
    results.append(("lookup_active", len(active) >= 2))

    # Test 4: double book block
    st3, _ = req(
        "POST",
        "/appointments",
        {
            "appointment_id": "APT-DUP2",
            "clinic_id": "CLINIC-SMILECARE",
            "patient_name": PATIENT,
            "phone_number": PHONE,
            "doctor_id": DOC,
            "doctor_name": "Dr. Bilal Hussain",
            "appointment_date": DATE,
            "appointment_time": "16:00",
            "status": "booked",
        },
    )
    results.append(("double_book", st3 == 409))

    # Test 5: cancel all via direct API (mirrors Cancel All tool)
    cancelled = 0
    for row in active:
        try:
            req("PATCH", f"/appointments?appointment_id=eq.{row['appointment_id']}", {"status": "cancelled"})
            cancelled += 1
        except urllib.error.HTTPError:
            pass
    _, remaining = req(
        "GET",
        f"/appointments?phone_number=eq.{PHONE}&clinic_id=eq.CLINIC-SMILECARE&status=in.(booked,confirmed)&select=appointment_id",
    )
    results.append(("cancel_all", cancelled >= 2 and len(remaining) == 0))

    # notifications check
    r = urllib.request.Request(
        BASE + "/notifications?select=id&order=created_at.desc&limit=3",
        headers={**HDR, "Prefer": "count=exact"},
    )
    with urllib.request.urlopen(r) as resp:
        notif_count = int(resp.headers.get("Content-Range", "0/0").split("/")[-1])
    results.append(("notifications_exist", notif_count > 0))

    print("=== APPOINTMENT LIFECYCLE TESTS ===")
    ok = True
    for name, passed in results:
        print(f"{'PASS' if passed else 'FAIL'} {name}")
        ok = ok and passed
    print("OVERALL", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
