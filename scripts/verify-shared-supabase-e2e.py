#!/usr/bin/env python3
"""E2E verification for shared Supabase database (SmileCare lifecycle)."""
import json
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
HDR = {
    "apikey": KEY,
    "Authorization": f"Bearer {KEY}",
    "Content-Type": "application/json",
}
DATE = "2026-08-25"
DOC = "DOC-003"
PHONE = "923025889452"
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
            body = {"raw": e.read().decode()}
        return e.code, body


def notif_count():
    r = urllib.request.Request(
        BASE + "/notifications?select=id",
        headers={**HDR, "Prefer": "count=exact"},
    )
    with urllib.request.urlopen(r) as resp:
        return int(resp.headers.get("Content-Range", "0/0").split("/")[-1])


def free_slot(date, doc, slot):
    _, booked = req(
        "GET",
        f"/appointments?clinic_id=eq.CLINIC-SMILECARE&doctor_id=eq.{doc}"
        f"&appointment_date=eq.{date}&status=neq.cancelled&select=appointment_time",
    )
    times = {b["appointment_time"] for b in booked}
    return slot not in times


def cancel_active(date, doc, slot):
    _, ex = req(
        "GET",
        f"/appointments?clinic_id=eq.CLINIC-SMILECARE&doctor_id=eq.{doc}"
        f"&appointment_date=eq.{date}&appointment_time=eq.{slot}"
        "&status=neq.cancelled&select=appointment_id",
    )
    for row in ex:
        req("PATCH", f"/appointments?appointment_id=eq.{row['appointment_id']}", {"status": "cancelled"})


def main():
    results = []
    nc0 = notif_count()

    # 1 Availability
    _, doctors = req("GET", f"/doctors?clinic_id=eq.CLINIC-SMILECARE&doctor_id=eq.{DOC}&select=*")
    slot = "13:30"
    cancel_active(DATE, DOC, slot)
    ok = bool(doctors) and free_slot(DATE, DOC, slot)
    results.append(("availability", ok))

    # 2 Book 1:30 PM
    apt = f"APT-E2E-{int(time.time()) % 100000000:08d}"
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
            "appointment_time": slot,
            "status": "booked",
        },
        prefer="return=representation",
    )
    nc1 = notif_count()
    results.append(("book_130pm", st in (200, 201) and nc1 > nc0))

    # 4 Double book
    st2, _ = req(
        "POST",
        "/appointments",
        {
            "appointment_id": "APT-DUP",
            "clinic_id": "CLINIC-SMILECARE",
            "patient_name": PATIENT,
            "phone_number": PHONE,
            "doctor_id": DOC,
            "doctor_name": "Dr. Bilal Hussain",
            "appointment_date": DATE,
            "appointment_time": slot,
            "status": "booked",
        },
    )
    results.append(("double_book", st2 == 409))

    # 6 Reschedule — pick free slot
    new_slot = "15:00"
    if not free_slot(DATE, DOC, new_slot):
        new_slot = "15:30"
    nc2 = notif_count()
    st3, rs = req(
        "PATCH",
        f"/appointments?appointment_id=eq.{apt}",
        {"appointment_date": DATE, "appointment_time": new_slot},
        prefer="return=representation",
    )
    nc3 = notif_count()
    resched_ok = st3 in (200, 204) or (isinstance(rs, list) and rs and rs[0].get("appointment_time") == new_slot)
    results.append(("reschedule", resched_ok and nc3 > nc2))

    # 5 Cancel
    nc4 = notif_count()
    st4, cn = req(
        "PATCH",
        f"/appointments?appointment_id=eq.{apt}",
        {"status": "cancelled"},
        prefer="return=representation",
    )
    nc5 = notif_count()
    cancel_ok = st4 in (200, 204) or (isinstance(cn, list) and cn and cn[0].get("status") == "cancelled")
    results.append(("cancel", cancel_ok and nc5 > nc4))

    # 3 Slot 10 equivalent (re-book 13:30)
    apt2 = f"APT-E2E2-{int(time.time()) % 100000000:08d}"
    st5, _ = req(
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
            "appointment_time": slot,
            "status": "booked",
        },
        prefer="return=representation",
    )
    results.append(("book_slot10_time", st5 in (200, 201)))
    req("PATCH", f"/appointments?appointment_id=eq.{apt2}", {"status": "cancelled"})

    print("=== E2E SHARED SUPABASE ===")
    all_ok = True
    for name, ok in results:
        print(f"{'PASS' if ok else 'FAIL'} {name}")
        all_ok = all_ok and ok
    print("OVERALL", "PASS" if all_ok else "FAIL")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
