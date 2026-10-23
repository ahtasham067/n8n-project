/**
 * Validates how the WhatsApp agent sits behind the CliniDesk gateway:
 *
 * - Meta's webhooks go to the dashboard, never to n8n. The agent starts from a
 *   webhook only the gateway can call (shared secret), and holds no Meta
 *   credential or clinic token.
 * - Every clinic detail (id, timezone, doctor, scope) comes from the gateway's
 *   payload; nothing names a clinic.
 * - Replies and voice notes go through the gateway, which uses the clinic's own
 *   number and token.
 * - Tools take the clinic and the patient's phone from trusted context, never
 *   from the model.
 *
 * Run: node scripts/test-whatsapp-routing.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const agent = read('WhatsApp AI Appointment Booking Agent.json');
const notify = read('Send Notification.json');
const TOOL_FILES = fs.readdirSync(root).filter((f) => /^Tool - .*\.json$/.test(f));

const CTX = 'Clinic Context';
const GUARD = 'Verify Gateway Secret';

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

const agentText = JSON.stringify(agent);

// --- Entry: gateway webhook -> secret check -> normalize ---------------------
const hook = node(agent, 'Gateway Webhook');
check(
  hook && hook.type === 'n8n-nodes-base.webhook' && hook.parameters.httpMethod === 'POST' && hook.parameters.path === 'clinidesk-inbound',
  'Gateway Webhook is POST /webhook/clinidesk-inbound',
  'Gateway Webhook missing or not POST /webhook/clinidesk-inbound',
);
check(
  !agent.nodes.some((n) => n.type === 'n8n-nodes-base.whatsAppTrigger' || n.type === 'n8n-nodes-base.whatsApp'),
  'agent has no Meta WhatsApp trigger or send node',
  'agent still has a Meta WhatsApp node',
);
check(
  !/whatsAppApi|whatsAppTriggerApi/.test(agentText),
  'agent holds no WhatsApp credential',
  'agent still references a WhatsApp credential',
);
check(!agentText.includes('graph.facebook.com'), 'agent never calls the Graph API', 'agent calls graph.facebook.com');

check(
  JSON.stringify(targets(agent, 'Gateway Webhook')) === JSON.stringify([GUARD]),
  `Gateway Webhook -> ${GUARD}`,
  `Gateway Webhook -> ${targets(agent, 'Gateway Webhook')}`,
);
check(
  JSON.stringify(targets(agent, GUARD, 0)) === JSON.stringify(['Normalize WhatsApp Message']),
  `${GUARD} (true) -> Normalize WhatsApp Message`,
  `${GUARD} (true) -> ${targets(agent, GUARD, 0)}`,
);
check(targets(agent, GUARD, 1).length === 0, `${GUARD} (false) drops the request`, `${GUARD} (false) is connected`);
check(
  JSON.stringify(targets(agent, 'Normalize WhatsApp Message')) === JSON.stringify(['Detect Message Type']),
  'Normalize WhatsApp Message -> Detect Message Type',
  `Normalize WhatsApp Message -> ${targets(agent, 'Normalize WhatsApp Message')}`,
);

const guard = node(agent, GUARD);
if (guard) {
  const expr = guard.parameters.conditions.conditions[0].leftValue.replace(/^=\{\{\s*/, '').replace(/\s*\}\}$/, '');
  const evaluate = new Function('$env', '$json', `return (${expr});`);
  const cases = [
    [{}, { 'x-clinidesk-secret': '' }, false, 'unset secret refuses everything'],
    [{ CLINIDESK_GATEWAY_SECRET: 's3cret' }, { 'x-clinidesk-secret': 's3cret' }, true, 'matching secret is accepted'],
    [{ CLINIDESK_GATEWAY_SECRET: 's3cret' }, { 'x-clinidesk-secret': 'guess' }, false, 'wrong secret is refused'],
    [{ CLINIDESK_GATEWAY_SECRET: 's3cret' }, {}, false, 'missing header is refused'],
  ];
  for (const [env, headers, expected, label] of cases) {
    const got = Boolean(evaluate(env, { headers }));
    check(got === expected, `guard: ${label}`, `guard: ${label} (got ${got})`);
  }
}

const normalize = node(agent, 'Normalize WhatsApp Message');
const assigned = Object.fromEntries(normalize.parameters.assignments.assignments.map((a) => [a.name, a.value]));
for (const [field, source] of [
  ['clinic_id', '$json.body.clinic_id'],
  ['phone_number_id', '$json.body.phone_number_id'],
  ['phone_number', '$json.body.from'],
]) {
  check(
    String(assigned[field] || '').includes(source),
    `Normalize ${field} comes from ${source}`,
    `Normalize ${field} is ${assigned[field]}`,
  );
}

// --- Human takeover (coexistence): staff context in, receive time out --------
check(
  String(assigned.inbound_received_at || '').includes('$json.body.received_at'),
  'Normalize inbound_received_at comes from the gateway',
  `Normalize inbound_received_at is ${assigned.inbound_received_at}`,
);
{
  const expr = String(assigned.staff_context_text || '').replace(/^=\{\{\s*/, '').replace(/\s*\}\}$/, '');
  let render = null;
  try {
    render = new Function('$json', `return (${expr});`);
  } catch (err) {
    check(false, '', `staff_context_text expression doesn't parse: ${err.message}`);
  }
  if (render) {
    check(
      render({ body: { staff_context: [{ text: 'Your report is ready' }, { text: 'Come at 5' }] } }) === '- Your report is ready\n- Come at 5',
      'staff_context_text lists what staff said, one line each',
      'staff_context_text renders wrongly',
    );
    check(render({ body: {} }) === '', 'no staff context renders as empty', 'empty staff context is not empty');
  }
}
const systemMessage = node(agent, 'Appointment Booking Agent').parameters.options.systemMessage;
check(
  systemMessage.includes("$('Normalize WhatsApp Message').item.json.staff_context_text") &&
    systemMessage.includes('do not repeat or contradict them'),
  'the prompt tells the bot to continue from what staff said',
  'the prompt does not use the staff context',
);

// --- Clinic context comes from the payload ----------------------------------
const ctx = node(agent, CTX);
check(!!ctx, `${CTX} node exists`, `${CTX} node missing`);
for (const a of ctx.parameters.assignments.assignments) {
  check(
    String(a.value).startsWith('={{'),
    `${CTX}.${a.name} is an expression`,
    `${CTX}.${a.name} is a literal: ${a.value}`,
  );
}
for (const literal of ['CLINIC-SMILECARE', 'Asia/Karachi', 'DOC-003', 'Pakistan Standard Time', 'Gastroenterology']) {
  check(!agentText.includes(literal), `agent does not hardcode "${literal}"`, `agent still contains "${literal}"`);
}

// --- Replies and media go through the gateway -------------------------------
const reply = node(agent, 'Send WhatsApp Reply');
check(
  reply.type === 'n8n-nodes-base.httpRequest' && reply.parameters.method === 'POST' &&
    reply.parameters.url === '={{ $env.CLINIDESK_GATEWAY_URL }}/api/internal/whatsapp/send',
  'Send WhatsApp Reply posts to the gateway /send',
  `Send WhatsApp Reply is ${reply.type} ${reply.parameters.url}`,
);
const secretHeader = (n) =>
  (n.parameters.headerParameters?.parameters || []).some(
    (h) => h.name === 'X-CliniDesk-Secret' && h.value === '={{ $env.CLINIDESK_GATEWAY_SECRET }}',
  );
check(secretHeader(reply), 'Send WhatsApp Reply sends the gateway secret', 'Send WhatsApp Reply has no gateway secret');
for (const field of ["inbound_received_at: $('Normalize WhatsApp Message').item.json.inbound_received_at", "clinic_id: $('Normalize WhatsApp Message').item.json.clinic_id", "phone_number_id: $('Normalize WhatsApp Message').item.json.phone_number_id", "to: $('Normalize WhatsApp Message').item.json.phone_number"]) {
  check(reply.parameters.jsonBody.includes(field), `reply body has ${field.split(':')[0]}`, `reply body is missing ${field}`);
}

const voice = node(agent, 'Download Voice Note');
check(
  voice.parameters.url.startsWith('={{ $env.CLINIDESK_GATEWAY_URL }}/api/internal/whatsapp/media/') && secretHeader(voice),
  'voice notes come from the gateway media proxy',
  `Download Voice Note fetches ${voice.parameters.url}`,
);
check(
  JSON.stringify(targets(agent, 'Detect Message Type', 0)) === JSON.stringify(['Download Voice Note']),
  'audio messages -> Download Voice Note',
  `audio messages -> ${targets(agent, 'Detect Message Type', 0)}`,
);

check(
  node(agent, 'Conversation Memory').parameters.sessionKey.includes("$('Normalize WhatsApp Message').item.json.clinic_id"),
  'chat memory is keyed by clinic and patient',
  'chat memory is not keyed by clinic',
);

// --- LLM calls go through the dashboard's per-clinic proxy -------------------
check(!/groqApi|api\.groq\.com/.test(agentText), 'agent holds no Groq key and never calls Groq directly', 'agent still uses a Groq credential or URL');
for (const name of ['CliniDesk Chat Model', 'CliniDesk Fallback Chat Model']) {
  const model = node(agent, name);
  check(
    model && model.type === '@n8n/n8n-nodes-langchain.lmChatOpenAi' &&
      model.parameters.options.baseURL === "={{ $env.CLINIDESK_GATEWAY_URL }}/api/internal/llm/{{ $('Clinic Context').item.json.clinic_id }}/v1",
    `${name} calls the LLM proxy for the calling clinic`,
    `${name} is ${model && model.type} ${model && model.parameters.options && model.parameters.options.baseURL}`,
  );
}
const transcribe = node(agent, 'Transcribe Voice Note');
check(
  transcribe.parameters.url.startsWith('={{ $env.CLINIDESK_GATEWAY_URL }}/api/internal/llm/') &&
    (transcribe.parameters.headerParameters?.parameters || []).some((h) => h.name === 'Authorization' && h.value.includes('$env.CLINIDESK_GATEWAY_SECRET')),
  'voice notes are transcribed through the LLM proxy',
  `Transcribe Voice Note posts to ${transcribe.parameters.url}`,
);

// --- IDs that bind the agent to its tool sub-workflows must not change -------
check(agent.id === 'nmXYYzPxvgMRZpm7', 'agent id unchanged', `agent id changed: ${agent.id}`);
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

// --- Tools: clinic and phone from trusted context, never from the model ------
const TRUSTED = (field) => `={{ $('${CTX}').item.json.${field} }}`;
for (const name of Object.keys(expectedTools)) {
  const value = node(agent, name).parameters.workflowInputs.value || {};
  check(value.clinic_id === TRUSTED('clinic_id'), `tool ${name} clinic_id is the gateway's clinic`, `tool ${name} clinic_id is ${value.clinic_id}`);
}
for (const name of ['BookAppointment', 'GetAppointment', 'CancelAppointment', 'RescheduleAppointment', 'CancelAllAppointments']) {
  const value = node(agent, name).parameters.workflowInputs.value || {};
  check(value.phone_number === TRUSTED('phone_number'), `tool ${name} phone_number is the WhatsApp sender`, `tool ${name} phone_number is ${value.phone_number}`);
  check(value.timezone === TRUSTED('clinic_timezone'), `tool ${name} timezone is the clinic's`, `tool ${name} timezone is ${value.timezone}`);
}
for (const field of ['phone_number', 'clinic_id', 'timezone']) {
  check(!agentText.includes(`$fromAI('${field}'`), `no tool lets the model choose ${field}`, `agent has a $fromAI('${field}') input`);
}

for (const file of TOOL_FILES) {
  const wf = read(file);
  const text = JSON.stringify(wf);
  for (const literal of ['CLINIC-SMILECARE', 'Asia/Karachi', '$env.CLINIC_ID']) {
    check(!text.includes(literal), `${file}: no "${literal}"`, `${file}: still contains "${literal}"`);
  }
  for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.httpRequest' && /\/rest\/v1\/(appointments|doctors)/.test(x.parameters.url || ''))) {
    check(
      n.parameters.method === 'POST' || /clinic_id=eq\.\{\{ \$\('Execute Workflow Trigger'\)\.item\.json\.clinic_id \}\}/.test(n.parameters.url),
      `${file}: ${n.name} is scoped to the calling clinic`,
      `${file}: ${n.name} is not scoped to the calling clinic: ${n.parameters.url}`,
    );
  }
}
for (const file of ['Tool - Cancel Appointment.json', 'Tool - Reschedule Appointment.json']) {
  const wf = read(file);
  for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.httpRequest' && /appointment_id=eq\./.test(x.parameters.url || ''))) {
    check(
      /&phone_number=eq\./.test(n.parameters.url),
      `${file}: ${n.name} only matches the sender's own appointment`,
      `${file}: ${n.name} looks up an appointment without a phone_number filter`,
    );
  }
}

// --- Legacy: Send Notification still serves one clinic until it reconnects ---
check(
  node(notify, 'Send WhatsApp Notification').parameters.phoneNumberId.includes('$env.WHATSAPP_PHONE_NUMBER_ID'),
  'legacy Send Notification uses WHATSAPP_PHONE_NUMBER_ID',
  'legacy Send Notification does not use WHATSAPP_PHONE_NUMBER_ID',
);

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll WhatsApp routing checks passed.');
