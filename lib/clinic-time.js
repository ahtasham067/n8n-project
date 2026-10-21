/**
 * Clinic presentation-layer time helpers.
 * Storage remains timezone-safe HH:mm (24-hour) in the database.
 * Display conversion happens here only, always in the clinic timezone.
 */
const { DateTime } = require('luxon');

const CLINIC_TIMEZONE = process.env.CLINIC_TIMEZONE || 'Asia/Karachi';

const PARSE_FORMATS = [
  'HH:mm',
  'H:mm',
  'HH:mm:ss',
  'H:mm:ss',
  'h:mm a',
  'h:mma',
  'hh:mm a',
  'hh:mma',
  'h a',
  'ha',
  'h:mm:ss a',
];

function parseClinicTime(raw, zone = CLINIC_TIMEZONE) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim().replace(/\s+/g, ' ');
  for (const fmt of PARSE_FORMATS) {
    const dt = DateTime.fromFormat(s, fmt, { zone, locale: 'en' });
    if (dt.isValid) return dt;
  }
  const iso = DateTime.fromISO(s, { zone });
  if (iso.isValid && /T|\d:\d/.test(s)) return iso;
  return null;
}

function toStoredTime(raw, zone = CLINIC_TIMEZONE) {
  const dt = parseClinicTime(raw, zone);
  return dt ? dt.toFormat('HH:mm') : null;
}

function formatTime12h(raw, zone = CLINIC_TIMEZONE) {
  const dt = parseClinicTime(raw, zone);
  if (!dt) return raw;
  return dt
    .setLocale('en-US')
    .toFormat('h:mm a')
    .replace(/\b(am|pm)\b/gi, (m) => m.toUpperCase());
}

function clinicNow(zone = CLINIC_TIMEZONE) {
  return DateTime.now().setZone(zone);
}

function formatDateDisplay(isoOrDate, zone = CLINIC_TIMEZONE) {
  const raw = String(isoOrDate || '').trim();
  const datePart = raw.includes('T') ? raw.split('T')[0] : raw.slice(0, 10);
  const dt = DateTime.fromISO(datePart, { zone });
  return dt.isValid ? dt.toFormat('MMMM d, yyyy') : raw;
}

module.exports = {
  CLINIC_TIMEZONE,
  PARSE_FORMATS,
  parseClinicTime,
  toStoredTime,
  formatTime12h,
  clinicNow,
  formatDateDisplay,
};
