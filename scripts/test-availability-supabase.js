#!/usr/bin/env node
/**
 * Availability probe + booked-slot regression test.
 * Run: node scripts/test-availability-supabase.js
 */
const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');
const {
  formatTime12h,
  clinicNow,
  formatDateDisplay,
  toStoredTime,
} = require('../lib/clinic-time');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const eq = trimmed.indexOf('=');
    const k = trimmed.slice(0, eq).trim();
    let v = trimmed.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

loadEnvFile(path.join(process.cwd(), '.env'));
loadEnvFile(path.join(__dirname, '..', '.env'));

const LOCAL_SERVICE_ROLE_FALLBACK =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  'http://127.0.0.1:54321';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || LOCAL_SERVICE_ROLE_FALLBACK;
const CLINIC_ID = process.env.CLINIC_ID || 'CLINIC-SMILECARE';
const DOCTOR_ID = 'DOC-003';
const CLINIC_TIMEZONE = process.env.CLINIC_TIMEZONE || 'Asia/Karachi';

if (!KEY) {
  console.error('Missing SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

async function supabaseGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return text ? JSON.parse(text) : [];
}

async function supabaseRpc(fn, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`RPC ${fn} HTTP ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function supabasePost(table, row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(row),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${table} HTTP ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function supabasePatch(table, filter, row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(row),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`PATCH ${table} HTTP ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

function computeAvailability(doctor, preferredDate, appointmentRows) {
  const dt = DateTime.fromISO(preferredDate, { zone: CLINIC_TIMEZONE });
  const workingDays = (doctor.working_days || '').split(',').map((d) => d.trim());
  const weekdayMap = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const weekdayName = weekdayMap[dt.weekday - 1];
  if (!workingDays.includes(weekdayName)) {
    return {
      success: true,
      available_slots: [],
      available_slots_display: [],
      message: `${doctor.doctor_name} does not work on ${weekdayName}.`,
    };
  }

  const [startStr, endStr] = (doctor.working_hours || '09:00-17:00').split('-');
  const duration = doctor.slot_duration_minutes || 30;
  let slotCursor = DateTime.fromFormat(startStr.trim(), 'HH:mm', { zone: CLINIC_TIMEZONE });
  const end = DateTime.fromFormat(endStr.trim(), 'HH:mm', { zone: CLINIC_TIMEZONE });
  const allSlots = [];
  while (slotCursor < end) {
    allSlots.push(slotCursor.toFormat('HH:mm'));
    slotCursor = slotCursor.plus({ minutes: duration });
  }

  const bookedTimes = appointmentRows
    .map((r) => toStoredTime(r.appointment_time))
    .filter(Boolean);
  let availableSlots = allSlots.filter((s) => !bookedTimes.includes(s));

  const now = clinicNow();
  if (dt.hasSame(now, 'day')) {
    availableSlots = availableSlots.filter((s) => {
      const slotDt = DateTime.fromFormat(s, 'HH:mm', { zone: CLINIC_TIMEZONE }).set({
        year: now.year,
        month: now.month,
        day: now.day,
      });
      return slotDt > now;
    });
  }

  const availableSlotsDisplay = availableSlots.map(formatTime12h);
  const dateDisplay = formatDateDisplay(preferredDate);
  const message = availableSlotsDisplay.length
    ? `Available slots for ${doctor.doctor_name} on ${dateDisplay}: ${availableSlotsDisplay.join(', ')}`
    : `No slots available for ${doctor.doctor_name} on ${dateDisplay}. Please try another date.`;

  return {
    success: true,
    available_slots: availableSlots,
    available_slots_display: availableSlotsDisplay,
    booked_slots: bookedTimes,
    message,
  };
}

async function checkAvailability(label, preferredDate) {
  const doctors = await supabaseGet(
    `/doctors?clinic_id=eq.${CLINIC_ID}&doctor_id=eq.${DOCTOR_ID}&select=*`,
  );
  if (!doctors.length) throw new Error(`Doctor ${DOCTOR_ID} not found`);
  const appointments = await supabaseGet(
    `/appointments?clinic_id=eq.${CLINIC_ID}&doctor_id=eq.${DOCTOR_ID}&appointment_date=eq.${preferredDate}&status=neq.cancelled&select=appointment_time,status`,
  );
  const result = computeAvailability(doctors[0], preferredDate, appointments);
  console.log(`\n=== ${label} (${preferredDate}) ===`);
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function checkRpcAvailability(preferredDate) {
  const result = await supabaseRpc('get_available_slots', {
    p_clinic_id: CLINIC_ID,
    p_doctor_id: DOCTOR_ID,
    p_date: preferredDate,
  });
  console.log(`\n=== RPC availability (${preferredDate}) ===`);
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function regressionBookedSlotExclusion() {
  const testDate = '2099-03-16'; // Monday
  const testTime = '10:00';
  const aptId = `APT-TEST${Date.now().toString().slice(-6)}`;

  console.log('\n=== Regression: book → exclude → cancel → restore ===');

  let before = await checkRpcAvailability(testDate);
  const beforeSlots = before.available_slots || [];
  if (!beforeSlots.includes('09:00')) {
    throw new Error('Expected 09:00 available before booking');
  }

  await supabasePost('appointments', {
    appointment_id: aptId,
    clinic_id: CLINIC_ID,
    patient_name: 'Slot Test Patient',
    phone_number: '+923000001111',
    doctor_id: DOCTOR_ID,
    doctor_name: 'Dr. Bilal Hussain',
    appointment_date: testDate,
    appointment_time: testTime,
    status: 'booked',
  });

  let during = await checkRpcAvailability(testDate);
  const duringSlots = during.available_slots || [];
  if (duringSlots.includes(testTime)) {
    throw new Error(`${testTime} must NOT appear after booking`);
  }
  if (!duringSlots.includes('09:00')) {
    throw new Error('09:00 should still be available when 10:00 is booked');
  }
  console.log('PASS: booked slot excluded from availability');

  await supabasePatch(
    'appointments',
    `appointment_id=eq.${aptId}`,
    { status: 'cancelled' },
  );

  let after = await checkRpcAvailability(testDate);
  const afterSlots = after.available_slots || [];
  if (!afterSlots.includes(testTime)) {
    throw new Error(`${testTime} should reappear after cancel`);
  }
  console.log('PASS: cancelled slot restored to availability');
}

(async () => {
  const today = clinicNow().toISODate();
  await checkAvailability('Test 1: today (legacy JS)', today);
  await checkRpcAvailability(today);
  await checkAvailability('Test 2: 25 August 2026', '2026-08-25');
  await regressionBookedSlotExclusion();
  console.log('\nAll availability tests passed.');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
