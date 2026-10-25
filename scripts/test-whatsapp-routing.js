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
  const expr = String(assigned.history_text || '').replace(/^=\{\{\s*/, '').replace(/\s*\}\}$/, '');
  let render = null;
  try {
    render = new Function('$json', `return (${expr});`);
  } catch (err) {
    check(false, '', `history_text expression doesn't parse: ${err.message}`);
  }
  if (render) {
    const history = [
      { role: 'patient', type: 'text', text: 'Kal appointment?' },
      { role: 'assistant', type: 'text', text: 'Ji, 10 se 11 khali hai.' },
      { role: 'staff', type: 'text', text: 'Fee 2000 hai' },
      { role: 'patient', type: 'audio', text: null },
    ];
    check(
      render({ body: { history } }) ===
        'Patient: Kal appointment?\nYou: Ji, 10 se 11 khali hai.\nClinic staff: Fee 2000 hai\nPatient: (voice note)',
      'history_text labels patient, assistant and staff lines, oldest first',
      `history_text renders wrongly: ${render({ body: { history } })}`,
    );
    check(render({ body: {} }) === '', 'no history renders as empty', 'empty history is not empty');
  }
}
check(!('staff_context_text' in assigned), 'staff messages come through the history, not a separate field', 'Normalize still sets staff_context_text');
const systemMessage = node(agent, 'Appointment Booking Agent').parameters.options.systemMessage;
check(
  systemMessage.includes("$('Normalize WhatsApp Message').item.json.history_text") &&
    systemMessage.includes('do not repeat or contradict them'),
  'the prompt gives the bot the chat so far and tells it to continue from staff',
  'the prompt does not use the history',
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

// The gateway sends the chat so far; in-process memory would break across
// queue-mode workers and keep replies that were never sent.
check(
  !agent.nodes.some((n) => /memory/i.test(n.type)) && !Object.keys(agent.connections).some((k) => /memory/i.test(k)),
  'the agent keeps no chat memory of its own',
  'the agent still has a memory node',
);
check(
  reply.parameters.jsonBody.includes("inbound_wamid: $('Normalize WhatsApp Message').item.json.wamid") &&
    reply.parameters.jsonBody.includes("$('Prepare AI Input').isExecuted ? ($('Prepare AI Input').item.json.message_text"),
  "the reply hands back the message id and a voice note's transcript",
  'the reply does not hand back inbound_wamid / inbound_text',
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
  // From version 1.1 the node hides the Base URL option and n8n drops it, so
  // the call goes to api.openai.com with the gateway secret as the key.
  check(
    model && model.typeVersion === 1 && typeof model.parameters.model === 'string',
    `${name} is version 1, which honours the Base URL option`,
    `${name} is version ${model && model.typeVersion}; n8n ignores options.baseURL from 1.1`,
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
  FindDoctor: 'uv2kXklXGCUD8xid',
  GetDoctorDetails: 'GtDocDetails0001',
  FindEarliestSlots: 'FindEarliest0001',
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
for (const name of ['BookAppointment', 'GetAppointment', 'CancelAppointment', 'RescheduleAppointment', 'CancelAllAppointments', 'FindDoctor', 'CheckDoctorAvailability']) {
  const value = node(agent, name).parameters.workflowInputs.value || {};
  check(value.phone_number === TRUSTED('phone_number'), `tool ${name} phone_number is the WhatsApp sender`, `tool ${name} phone_number is ${value.phone_number}`);
}
for (const name of ['GetAppointment', 'CancelAppointment', 'CancelAllAppointments']) {
  const value = node(agent, name).parameters.workflowInputs.value || {};
  check(value.timezone === TRUSTED('clinic_timezone'), `tool ${name} timezone is the clinic's`, `tool ${name} timezone is ${value.timezone}`);
}

// --- Multi-doctor: thin tools over the dashboard's bot_* RPCs -----------------
const RPC_TOOLS = {
  'Tool - Find Doctor.json': 'bot_find_doctors',
  'Tool - Get Doctor Details.json': 'bot_doctor_details',
  'Tool - Check Doctor Availability.json': 'bot_doctor_availability',
  'Tool - Find Earliest Slots.json': 'bot_earliest_slots',
  'Tool - Book Appointment.json': 'bot_book_appointment',
  'Tool - Reschedule Appointment.json': 'bot_reschedule',
};
for (const [file, rpc] of Object.entries(RPC_TOOLS)) {
  const wf = read(file);
  const http = wf.nodes.find((x) => x.type === 'n8n-nodes-base.httpRequest');
  check(http && http.parameters.url.endsWith(`/rest/v1/rpc/${rpc}`) && http.parameters.jsonBody.includes('p_clinic_id: $json.clinic_id'),
    `${file} calls ${rpc} for the calling clinic`, `${file} does not call ${rpc}`);
  const expectedId = Object.entries(expectedTools).find(([, id]) => id === wf.id);
  check(Boolean(expectedId), `${file} has the id the agent calls (${wf.id})`, `${file} id ${wf.id} isn't referenced by the agent`);
}
check(!fs.existsSync(path.join(root, 'Tool - Search Doctors.json')), 'old Search Doctors tool is gone', 'Tool - Search Doctors.json still exists');

// The doctor blocks render for one doctor and for several.
{
  const sm = node(agent, 'Appointment Booking Agent').parameters.options.systemMessage;
  const exprs = [...sm.matchAll(/\{\{([\s\S]*?)\}\}/g)].map((m) => m[1]).filter((e) => e.includes('doctor_count'));
  check(exprs.length >= 3, 'the prompt switches on doctor_count', `the prompt has ${exprs.length} doctor_count blocks`);
  const ctxFor = (count) => ({
    doctor_count: String(count), doctors_roster: '1. Dr. A - Skin [doctor_id DOC-A]', clinic_name: 'C', clinic_specialty: 'Skin',
    doctor_name: 'Dr. A', specialty: 'Skin', doctor_id: 'DOC-A', selection_text: count > 1 ? 'Dr. A (doctor_id DOC-A)' : '',
  });
  for (const count of [1, 3]) {
    const ctx = ctxFor(count);
    const $ = () => ({ item: { json: ctx } });
    const rendered = exprs.map((e) => new Function('$', `return (${e});`)($)).join('\n');
    if (count === 1) {
      check(rendered.includes('single doctor only') && !rendered.includes('DOCTOR SELECTION'), 'one doctor renders the single-doctor rules', 'one doctor renders the wrong rules');
    } else {
      check(rendered.includes('DOCTOR SELECTION') && rendered.includes('Current selection: Dr. A') && rendered.includes('[doctor_id DOC-A]'),
        'several doctors render the roster, selection and multi-doctor rules', 'several doctors render the wrong rules');
    }
  }
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

// --- Scheduler: the dashboard's frequent crons (Vercel Hobby runs them daily) ---
const scheduler = read('CliniDesk Scheduler.json');
const schedulerText = JSON.stringify(scheduler);
const every = node(scheduler, 'Every 15 Minutes');
check(
  every?.type === 'n8n-nodes-base.scheduleTrigger' &&
    every.parameters.rule.interval[0].field === 'minutes' &&
    every.parameters.rule.interval[0].minutesInterval === 15,
  'scheduler runs every 15 minutes',
  'scheduler trigger is not every 15 minutes',
);
const alertsCall = node(scheduler, 'Run Platform Alerts');
check(
  targets(scheduler, 'Every 15 Minutes').includes('Run Platform Alerts') &&
    alertsCall.parameters.url === '={{ $env.CLINIDESK_GATEWAY_URL }}/api/cron/platform-alerts',
  'scheduler calls /api/cron/platform-alerts on the gateway URL',
  `scheduler calls ${alertsCall?.parameters.url}`,
);
check(
  (alertsCall.parameters.headerParameters?.parameters || []).some(
    (h) => h.name === 'Authorization' && h.value === '=Bearer {{ $env.CLINIDESK_CRON_SECRET }}',
  ),
  'scheduler sends CLINIDESK_CRON_SECRET as a bearer token',
  'scheduler has no cron secret header',
);
check(
  !/https?:\/\//.test(schedulerText) && !/\d{10,}/.test(schedulerText),
  'scheduler hardcodes no host and no number',
  'scheduler contains a literal URL or a long number',
);

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll WhatsApp routing checks passed.');
