/**
 * Validates WhatsApp sender routing: replies go out from the business number that
 * received the message, and each environment only answers its allowed numbers.
 * Run: node scripts/test-whatsapp-routing.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const agent = JSON.parse(fs.readFileSync(path.join(root, 'WhatsApp AI Appointment Booking Agent.json'), 'utf8'));
const notify = JSON.parse(fs.readFileSync(path.join(root, 'Send Notification.json'), 'utf8'));

const GUARD = 'Allowed Business Number?';

let failed = 0;
function check(ok, pass, fail) {
  if (ok) {
    console.log(`PASS  ${pass}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${fail}`);
  }
}

function node(wf, name) {
  return wf.nodes.find((n) => n.name === name);
}

function targets(wf, from, output = 0) {
  const out = ((wf.connections[from] || {}).main || [])[output] || [];
  return out.map((c) => c.node);
}

// No WhatsApp send node may hardcode a Phone Number ID
for (const [label, wf] of [['agent', agent], ['Send Notification', notify]]) {
  for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.whatsApp')) {
    const id = String(n.parameters.phoneNumberId || '');
    check(
      id.startsWith('=') && !/^\d+$/.test(id),
      `${label}: ${n.name} phoneNumberId is an expression`,
      `${label}: ${n.name} hardcodes phoneNumberId ${id}`,
    );
  }
}

const reply = node(agent, 'Send WhatsApp Reply');
check(
  reply.parameters.phoneNumberId.includes("$('Normalize WhatsApp Message').item.json.phone_number_id"),
  'Send WhatsApp Reply uses the receiving phone_number_id',
  'Send WhatsApp Reply does not use the receiving phone_number_id',
);
check(
  reply.parameters.phoneNumberId.includes('$env.WHATSAPP_PHONE_NUMBER_ID'),
  'Send WhatsApp Reply falls back to WHATSAPP_PHONE_NUMBER_ID',
  'Send WhatsApp Reply has no WHATSAPP_PHONE_NUMBER_ID fallback',
);
check(
  node(notify, 'Send WhatsApp Notification').parameters.phoneNumberId.includes('$env.WHATSAPP_PHONE_NUMBER_ID'),
  'Send WhatsApp Notification uses WHATSAPP_PHONE_NUMBER_ID',
  'Send WhatsApp Notification does not use WHATSAPP_PHONE_NUMBER_ID',
);

const normalize = node(agent, 'Normalize WhatsApp Message');
const pnid = normalize.parameters.assignments.assignments.find((a) => a.name === 'phone_number_id');
check(
  pnid && pnid.value.includes('metadata?.phone_number_id'),
  'Normalize WhatsApp Message extracts metadata.phone_number_id',
  'Normalize WhatsApp Message is missing phone_number_id',
);

// Guard wiring: Normalize -> guard (true) -> Detect Message Type; false branch drops
const guard = node(agent, GUARD);
check(!!guard, `${GUARD} node exists`, `${GUARD} node missing`);
check(
  JSON.stringify(targets(agent, 'Normalize WhatsApp Message')) === JSON.stringify([GUARD]),
  `Normalize WhatsApp Message -> ${GUARD}`,
  `Normalize WhatsApp Message -> ${targets(agent, 'Normalize WhatsApp Message')}`,
);
check(
  JSON.stringify(targets(agent, GUARD, 0)) === JSON.stringify(['Detect Message Type']),
  `${GUARD} (true) -> Detect Message Type`,
  `${GUARD} (true) -> ${targets(agent, GUARD, 0)}`,
);
check(targets(agent, GUARD, 1).length === 0, `${GUARD} (false) drops the message`, `${GUARD} (false) is connected`);

// Guard expression behaviour
if (guard) {
  const expr = guard.parameters.conditions.conditions[0].leftValue.replace(/^=\{\{\s*/, '').replace(/\s*\}\}$/, '');
  const evaluate = new Function('$env', '$json', `return (${expr});`);
  const cases = [
    [{}, '111', true, 'unset allowlist answers every number'],
    [{ WHATSAPP_ALLOWED_PHONE_NUMBER_IDS: '' }, '111', true, 'empty allowlist answers every number'],
    [{ WHATSAPP_ALLOWED_PHONE_NUMBER_IDS: '111' }, '111', true, 'listed number is answered'],
    [{ WHATSAPP_ALLOWED_PHONE_NUMBER_IDS: '111' }, '222', false, 'unlisted number is dropped'],
    [{ WHATSAPP_ALLOWED_PHONE_NUMBER_IDS: '111, 222' }, '222', true, 'comma list with spaces is accepted'],
    [{ WHATSAPP_ALLOWED_PHONE_NUMBER_IDS: '111' }, '', false, 'missing phone_number_id is dropped when a list is set'],
  ];
  for (const [env, id, expected, label] of cases) {
    const got = Boolean(evaluate(env, { phone_number_id: id }));
    check(got === expected, `guard: ${label}`, `guard: ${label} (got ${got})`);
  }
}

// IDs that bind the agent to Meta and to its tool sub-workflows must not change
check(agent.id === 'nmXYYzPxvgMRZpm7', 'agent id unchanged', `agent id changed: ${agent.id}`);
const trigger = node(agent, 'WhatsApp Trigger');
check(
  trigger.webhookId === 'e60f653f-a2f6-4686-909b-f3cca62cad2c' && trigger.id === '4d182743-5c30-44b2-8bb7-b346135a7e70',
  'WhatsApp Trigger webhookId and node id (verify token) unchanged',
  'WhatsApp Trigger webhookId or node id changed',
);
const expectedTools = {
  CheckDoctorAvailability: 'K3aQylfpGB7OIUmy',
  BookAppointment: 'vlxq9W4WX10a6sOt',
  CancelAppointment: 'YU0xJOfDAWTgu7ie',
  RescheduleAppointment: 'Z1FoatldEaEwpbS4',
  GetAppointment: 'L3GjYUaO84jum665',
  SearchDoctors: 'uv2kXklXGCUD8xid',
  CancelAllAppointments: 'CaA1lAppt0000001',
  GetClinicInfo: 'hgi4PY0JBWmkpQBU',
};
for (const [name, id] of Object.entries(expectedTools)) {
  const t = node(agent, name);
  const got = t && t.parameters.workflowId && t.parameters.workflowId.value;
  check(got === id, `tool ${name} -> ${id}`, `tool ${name} -> ${got}, expected ${id}`);
}

// The patient's phone comes from the WhatsApp sender, never from the model.
// Otherwise a patient can ask the bot to read, book, cancel or reschedule
// appointments that belong to another number.
const TRUSTED_PHONE = "={{ $('Dental Clinic Config').item.json.phone_number }}";
for (const name of ['BookAppointment', 'GetAppointment', 'CancelAppointment', 'RescheduleAppointment', 'CancelAllAppointments']) {
  const value = node(agent, name).parameters.workflowInputs.value || {};
  check(
    value.phone_number === TRUSTED_PHONE,
    `tool ${name} phone_number is the WhatsApp sender`,
    `tool ${name} phone_number is ${value.phone_number}`,
  );
}
check(
  !JSON.stringify(agent).includes("$fromAI('phone_number'"),
  'no tool lets the model choose phone_number',
  "agent still has a $fromAI('phone_number') input",
);
for (const file of ['Tool - Cancel Appointment.json', 'Tool - Reschedule Appointment.json']) {
  const wf = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.httpRequest' && /appointment_id=eq\./.test(x.parameters.url || ''))) {
    check(
      /&phone_number=eq\./.test(n.parameters.url),
      `${file}: ${n.name} only matches the sender's own appointment`,
      `${file}: ${n.name} looks up an appointment without a phone_number filter`,
    );
  }
}

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll WhatsApp routing checks passed.');
