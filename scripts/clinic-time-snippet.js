// --- Clinic time formatting (presentation layer only; DB stores HH:mm) ---
const CLINIC_TIMEZONE = 'Asia/Karachi';

function parseClinicTime(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim().replace(/\s+/g, ' ');
  const zone = CLINIC_TIMEZONE;
  const formats = ['HH:mm', 'H:mm', 'HH:mm:ss', 'H:mm:ss', 'h:mm a', 'h:mma', 'hh:mm a', 'hh:mma', 'h a', 'ha', 'h:mm:ss a'];
  for (const fmt of formats) {
    const dt = DateTime.fromFormat(s, fmt, { zone, locale: 'en' });
    if (dt.isValid) return dt;
  }
  const iso = DateTime.fromISO(s, { zone });
  if (iso.isValid && /T|\d:\d/.test(s)) return iso;
  return null;
}

function toStoredTime(raw) {
  const dt = parseClinicTime(raw);
  return dt ? dt.toFormat('HH:mm') : null;
}

function formatTime12h(raw) {
  const dt = parseClinicTime(raw);
  if (!dt) return raw;
  return dt.setLocale('en-US').toFormat('h:mm a').replace(/\b(am|pm)\b/gi, (m) => m.toUpperCase());
}

function clinicNow() {
  return DateTime.now().setZone(CLINIC_TIMEZONE);
}

function formatDateDisplay(isoOrDate) {
  const raw = String(isoOrDate || '').trim();
  const datePart = raw.includes('T') ? raw.split('T')[0] : raw.slice(0, 10);
  const dt = DateTime.fromISO(datePart, { zone: CLINIC_TIMEZONE });
  return dt.isValid ? dt.toFormat('MMMM d, yyyy') : raw;
}
// --- end clinic time formatting ---
