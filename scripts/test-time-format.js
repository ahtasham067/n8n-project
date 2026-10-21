const assert = require('assert');
const {
  CLINIC_TIMEZONE,
  formatTime12h,
  toStoredTime,
  formatDateDisplay,
  parseClinicTime,
} = require('../lib/clinic-time');

const cases = [
  ['09:00', '9:00 AM', '09:00'],
  ['9:00', '9:00 AM', '09:00'],
  ['11:30', '11:30 AM', '11:30'],
  ['12:00', '12:00 PM', '12:00'],
  ['13:00', '1:00 PM', '13:00'],
  ['14:00', '2:00 PM', '14:00'],
  ['15:45', '3:45 PM', '15:45'],
  ['19:30', '7:30 PM', '19:30'],
  ['00:00', '12:00 AM', '00:00'],
  ['23:59', '11:59 PM', '23:59'],
  ['9:00 AM', '9:00 AM', '09:00'],
  ['11:30 AM', '11:30 AM', '11:30'],
  ['12:00 PM', '12:00 PM', '12:00'],
  ['12:00 AM', '12:00 AM', '00:00'],
  ['2:00 PM', '2:00 PM', '14:00'],
  ['7:30 PM', '7:30 PM', '19:30'],
  ['3:30pm', '3:30 PM', '15:30'],
  ['09:00:00', '9:00 AM', '09:00'],
];

let failed = 0;
for (const [input, display, stored] of cases) {
  const gotDisplay = formatTime12h(input);
  const gotStored = toStoredTime(input);
  try {
    assert.strictEqual(gotDisplay, display, `display ${input}`);
    assert.strictEqual(gotStored, stored, `stored ${input}`);
    console.log(`PASS  ${input.padEnd(12)} -> display ${gotDisplay.padEnd(10)} stored ${gotStored}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL  ${input}: display=${gotDisplay} stored=${gotStored} (${err.message})`);
  }
}

assert.strictEqual(CLINIC_TIMEZONE, 'Asia/Karachi');
assert.strictEqual(formatDateDisplay('2026-08-21'), 'August 21, 2026');
assert.ok(parseClinicTime('09:00').zoneName === 'Asia/Karachi');

const noon = parseClinicTime('12:00');
const midnight = parseClinicTime('00:00');
assert.strictEqual(noon.hour, 12);
assert.strictEqual(midnight.hour, 0);
assert.strictEqual(formatTime12h('12:00'), '12:00 PM');
assert.strictEqual(formatTime12h('00:00'), '12:00 AM');

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nAll time-format tests passed.');
