#!/usr/bin/env node
/**
 * Local end-to-end test: WhatsApp booking, reschedule and cancel through a
 * real n8n running these workflows, with dashboard notifications checked in
 * the database. Local only; nothing here touches production.
 *
 *   patient message (signed Meta webhook, simulated)
 *     -> local dashboard /api/whatsapp/webhook (gateway, billing gate)
 *     -> throwaway local n8n (this repo's workflows, imported by fixed id)
 *     -> agent -> dashboard LLM proxy -> scripted mock LLM (tool calls)
 *     -> Tool - Book / Reschedule / Cancel -> Supabase RPC / REST
 *     -> appointments trigger -> notifications (per staff, per clinic)
 *     -> reply via dashboard /api/internal/whatsapp/send -> Meta test number
 *        (or a mock Graph when the local test token no longer works)
 *
 * Needs: Docker, the dashboard's local Supabase (`npm run supabase:start` in
 * Dentalclinic-dashboard) and a dashboard build (`npm run build` there).
 * Reads WHATSAPP_NUMBER_PROFILE, WHATSAPP_PHONE_NUMBER_ID,
 * WHATSAPP_ACCESS_TOKEN and WHATSAPP_TEST_RECIPIENT from .env.docker. Tokens
 * and numbers are never printed. Inbound messages are simulated, so the Meta
 * app's webhook URL is never changed.
 *
 *   node scripts/e2e-local-flow.mjs            # real test number if its token works
 *   E2E_GRAPH=mock node scripts/e2e-local-flow.mjs
 *   KEEP=1 ...                                 # leave the n8n container running
 */
import { execFileSync, spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DASHBOARD = path.resolve(process.env.DASHBOARD_DIR || path.join(ROOT, "..", "Dentalclinic-dashboard"));
const N8N_IMAGE = process.env.N8N_IMAGE || "docker.n8n.io/n8nio/n8n:2.34.6";
const N8N_NAME = "n8n-clinidesk-e2e";
const N8N_VOLUME = "n8n-clinidesk-e2e-data";
const N8N_PORT = 5690;
const DASH_PORT = 3300;
const LLM_PORT = 4114;
const GRAPH_PORT = 4110;
const CLINIC = "CLINIC-SMILECARE";
const OTHER_CLINIC = "CLINIC-OTHER";
const TZ = "Asia/Karachi";

const results = [];
function step(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readEnvFile(file) {
  if (!existsSync(file)) return {};
  return Object.fromEntries(
    readFileSync(file, "utf8")
      .split("\n")
      .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/))
      .filter(Boolean)
      .map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]),
  );
}

/** Runs a command; on failure throws only the last lines of its output (never its arguments). */
function sh(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...opts });
  } catch (err) {
    const out = `${err.stdout ?? ""}\n${err.stderr ?? ""}`.split("\n").filter(Boolean).slice(-6).join("\n");
    throw new Error(`${cmd} ${args[0] ?? ""} ${args[1] ?? ""} failed:\n${out}`);
  }
}

function clinicDate(offsetDays) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(Date.now() + offsetDays * 86_400_000));
}
function nextWeekday(from) {
  for (let i = from; i < from + 7; i++) {
    const d = clinicDate(i);
    const day = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (day >= 1 && day <= 5) return d;
  }
  throw new Error("no weekday");
}

// --- Local Supabase (refuses anything that isn't local) ----------------------
const supa = Object.fromEntries(
  sh("npx", ["supabase", "status", "-o", "env"], { cwd: DASHBOARD, env: { ...process.env, TMPDIR: "./.tmp" } })
    .split("\n")
    .map((l) => l.match(/^([A-Z_]+)="?(.*?)"?$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
if (!/^http:\/\/(127\.0\.0\.1|localhost):54321$/.test(supa.API_URL || "")) {
  console.error(`Refusing to run: the dashboard's Supabase must be the local stack on :54321 (got "${supa.API_URL}").`);
  process.exit(2);
}
const DB_CONTAINER = `supabase_db_${readFileSync(path.join(DASHBOARD, "supabase/config.toml"), "utf8").match(/project_id\s*=\s*"([^"]+)"/)[1]}`;

function sql(text) {
  // stdin, so values (the test token) never appear in a process list or log.
  return sh("docker", ["exec", "-i", DB_CONTAINER, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-qtA"], {
    input: text,
  }).trim();
}
const lit = (v) => (v === null || v === undefined ? "null" : `'${String(v).replace(/'/g, "''")}'`);

async function rest(pathAndQuery) {
  const res = await fetch(`${supa.API_URL}/rest/v1/${pathAndQuery}`, {
    headers: { apikey: supa.SERVICE_ROLE_KEY, Authorization: `Bearer ${supa.SERVICE_ROLE_KEY}` },
  });
  return res.json();
}

async function poll(fn, { timeout = 60_000, every = 1500 } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = await fn();
    if (last) return last;
    await sleep(every);
  }
  return last;
}

// --- The Meta test number (from .env.docker) ---------------------------------
const n8nEnv = readEnvFile(path.join(ROOT, ".env.docker"));
if (n8nEnv.WHATSAPP_NUMBER_PROFILE !== "test") {
  console.error("Refusing to run: WHATSAPP_NUMBER_PROFILE in .env.docker must be 'test' (Meta's test number only).");
  process.exit(2);
}
const PHONE_ID = (n8nEnv.WHATSAPP_PHONE_NUMBER_ID || "").replace(/\D/g, "") || "9900001";
const TOKEN = n8nEnv.WHATSAPP_ACCESS_TOKEN || "";
const GRAPH_VERSION =
  readFileSync(path.join(DASHBOARD, "src/lib/whatsapp/graph.ts"), "utf8").match(/GRAPH_API_VERSION = "([^"]+)"/)?.[1] ||
  "v26.0";

let graphMode = process.env.E2E_GRAPH === "mock" ? "mock" : "real";
if (graphMode === "real") {
  try {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_ID}?fields=id`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok || !TOKEN) graphMode = "mock";
    console.log(`Meta test token check: ${res.ok ? "valid" : `HTTP ${res.status}`} -> replies via ${graphMode === "real" ? "the Meta test number" : "a mock Graph"}`);
  } catch {
    graphMode = "mock";
    console.log("Meta test token check: unreachable -> replies via a mock Graph");
  }
}
// A real reply needs a recipient Meta allows for the test number.
const RECIPIENT = (n8nEnv.WHATSAPP_TEST_RECIPIENT || "").replace(/\D/g, "");
if (graphMode === "real" && !RECIPIENT) {
  graphMode = "mock";
  console.log("WHATSAPP_TEST_RECIPIENT is empty in .env.docker -> replies via a mock Graph (set it to send for real).");
}
const PATIENT = graphMode === "real" ? RECIPIENT : "923001119901";

// --- Mock LLM (OpenAI-compatible) and mock Graph -----------------------------
const state = { expect: null, appointmentId: null, doctorId: null, llmCalls: 0, toolCalls: [], graphSends: [] };

function argsFor(tool) {
  const props = Object.keys(tool.function?.parameters?.properties || {});
  const value = {
    appointment_date: nextWeekday(2),
    appointment_time: "10:00",
    new_date: nextWeekday(3),
    new_time: "11:00",
    // Tool inputs are strings; "" means "not chosen" to the tool workflows.
    doctor_id: state.doctorId || "",
    new_doctor_id: "",
    patient_name: "E2E Local Patient",
    appointment_id: state.appointmentId || "",
  };
  return Object.fromEntries(props.map((p) => [p, p in value ? value[p] : ""]));
}

function completion(body, message, finish) {
  const base = { id: `chatcmpl-${randomBytes(6).toString("hex")}`, created: Math.floor(Date.now() / 1000), model: body.model || "mock" };
  const usage = { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 };
  if (!body.stream) {
    return { json: { ...base, object: "chat.completion", choices: [{ index: 0, message, finish_reason: finish }], usage } };
  }
  const chunks = [];
  const delta = message.tool_calls
    ? { role: "assistant", content: null, tool_calls: message.tool_calls.map((t, i) => ({ index: i, ...t })) }
    : { role: "assistant", content: message.content };
  chunks.push({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] });
  chunks.push({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finish }] });
  chunks.push({ ...base, object: "chat.completion.chunk", choices: [], usage });
  return { sse: chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n" };
}

function llmAnswer(body) {
  state.llmCalls += 1;
  const messages = body.messages || [];
  const tools = body.tools || [];
  const lastUser = messages.map((m) => m.role).lastIndexOf("user");
  const toolResult = messages.slice(lastUser + 1).find((m) => m.role === "tool");
  if (!tools.length || !state.expect) {
    return completion(body, { role: "assistant", content: "Thank you, the clinic team will help you." }, "stop");
  }
  if (toolResult) {
    const text = typeof toolResult.content === "string" ? toolResult.content : JSON.stringify(toolResult.content);
    return completion(body, { role: "assistant", content: `Done (${state.expect}). ${text.slice(0, 200)}` }, "stop");
  }
  const pick = {
    book: (n) => /^book/i.test(n),
    reschedule: (n) => /reschedule/i.test(n),
    cancel: (n) => /^cancel/i.test(n) && !/all/i.test(n),
  }[state.expect];
  const tool = tools.find((t) => pick(t.function?.name || ""));
  if (!tool) {
    return completion(body, { role: "assistant", content: `No ${state.expect} tool offered.` }, "stop");
  }
  const call = { id: `call_${randomBytes(4).toString("hex")}`, type: "function", function: { name: tool.function.name, arguments: JSON.stringify(argsFor(tool)) } };
  state.toolCalls.push({ step: state.expect, name: tool.function.name, args: call.function.arguments });
  return completion(body, { role: "assistant", content: null, tool_calls: [call] }, "tool_calls");
}

function listen(port, handler) {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => handler(req, res, raw));
  });
  return new Promise((r) => server.listen(port, "127.0.0.1", () => r(server)));
}

const llmServer = await listen(LLM_PORT, (req, res, raw) => {
  if (req.method === "POST" && req.url.endsWith("/chat/completions")) {
    const out = llmAnswer(JSON.parse(raw || "{}"));
    if (out.sse) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(out.sse);
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out.json));
    }
    return;
  }
  res.writeHead(404).end();
});
const graphServer = await listen(GRAPH_PORT, (req, res, raw) => {
  if (req.method === "POST" && /\/messages$/.test(req.url)) {
    const body = JSON.parse(raw || "{}");
    state.graphSends.push({ to: body.to, type: body.type });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: `wamid.mock.${state.graphSends.length}` }] }));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end("{}");
});

// --- Secrets for this run only ------------------------------------------------
const GATEWAY_SECRET = randomBytes(24).toString("hex");
const APP_SECRET = randomBytes(24).toString("hex");
const CRON_SECRET = randomBytes(24).toString("hex");

// --- Fixtures: SmileCare on the test number, writable, bot on -----------------
state.doctorId = sql(`select doctor_id from public.doctors where clinic_id = ${lit(CLINIC)} and is_active and bot_visible order by doctor_id limit 1;`) || null;
sql(`
begin;
delete from public.whatsapp_accounts where phone_number_id = ${lit(PHONE_ID)} or clinic_id = ${lit(CLINIC)};
update public.clinics set status = 'active', current_period_end = now() + interval '30 days', grace_until = null,
  suspension_reason = null, platform_bot_override = null, bot_enabled = true
where clinic_id = ${lit(CLINIC)};
delete from public.appointments where clinic_id = ${lit(CLINIC)} and phone_number like ${lit(`%${PATIENT.slice(-10)}`)};
delete from public.conversation_state where clinic_id = ${lit(CLINIC)} and patient_wa = ${lit(PATIENT)};
delete from public.notifications where patient_phone = ${lit(PATIENT)};
insert into public.whatsapp_accounts (clinic_id, waba_id, phone_number_id, display_phone_number, status,
  meta_payment_status, connection_mode, token_secret_id, onboarded_at)
values (${lit(CLINIC)}, 'e2e-local-waba', ${lit(PHONE_ID)}, 'Meta test number', 'connected', 'verified', 'cloud_api',
  vault.create_secret(${lit(TOKEN || "mock-token")}, ${lit(`e2e-local-${Date.now()}`)}), now());
commit;
`);

// --- Dashboard ------------------------------------------------------------------
if (!existsSync(path.join(DASHBOARD, ".next", "BUILD_ID"))) {
  console.error("Build the dashboard first: (cd Dentalclinic-dashboard && npm run build)");
  process.exit(2);
}
const dashEnv = {
  ...process.env,
  NODE_ENV: "production",
  NEXT_PUBLIC_SUPABASE_URL: supa.API_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: supa.ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: supa.SERVICE_ROLE_KEY,
  CLINIDESK_GATEWAY_SECRET: GATEWAY_SECRET,
  META_APP_ID: "local-e2e",
  META_APP_SECRET: APP_SECRET,
  N8N_INBOUND_URL: `http://127.0.0.1:${N8N_PORT}/webhook/clinidesk-inbound`,
  LLM_PRIMARY_BASE_URL: `http://127.0.0.1:${LLM_PORT}/v1`,
  LLM_PRIMARY_API_KEY: "mock-llm",
  LLM_PRIMARY_NAME: "mock",
  WHATSAPP_TEST_PHONE_NUMBER_IDS: PHONE_ID,
  WHATSAPP_REAL_PHONE_NUMBER_IDS: "",
  CRON_SECRET,
  RESEND_API_KEY: "",
  ...(graphMode === "mock" ? { META_GRAPH_BASE_URL: `http://127.0.0.1:${GRAPH_PORT}` } : {}),
};
delete dashEnv.VERCEL_ENV;
const dashLog = [];
// Its own process group, so stopping it also stops next-server under npx.
const dashboard = spawn("npx", ["next", "start", "-p", String(DASH_PORT)], { cwd: DASHBOARD, env: dashEnv, detached: true });
dashboard.stdout.on("data", (d) => dashLog.push(String(d)));
dashboard.stderr.on("data", (d) => dashLog.push(String(d)));

// --- Throwaway n8n with this repo's workflows ---------------------------------------
// Inside the repo (gitignored): Docker must be able to mount it.
mkdirSync(path.join(ROOT, ".e2e"), { recursive: true });
const stage = mkdtempSync(path.join(ROOT, ".e2e", "run-"));
chmodSync(stage, 0o755);
const manifest = readFileSync(path.join(ROOT, "deploy/vm/workflows.txt"), "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"))
  .map((l) => ({ id: l.split(/\s+/)[0], file: l.replace(/^\S+\s+/, "") }));
const wfDir = path.join(stage, "workflows");
mkdirSync(wfDir, { recursive: true });
for (const { file } of manifest) cpSync(path.join(ROOT, file), path.join(wfDir, path.basename(file)));
writeFileSync(
  path.join(stage, "credentials.json"),
  JSON.stringify([
    { id: "CliniDeskLlmProxy", name: "CliniDesk LLM proxy", type: "openAiApi", data: { apiKey: GATEWAY_SECRET } },
    { id: "m3V5iKCzv82oBoW9", name: "SMTP account", type: "smtp", data: { user: "", password: "", host: "127.0.0.1", port: 2525, secure: false } },
  ]),
);
sh("chmod", ["-R", "a+rX", stage]);

const encryptionKey = randomBytes(24).toString("hex");
// Secrets go in an env file (not on the command line, so an error can't print them).
const envFile = path.join(stage, "n8n.env");
writeFileSync(envFile, [
  `N8N_ENCRYPTION_KEY=${encryptionKey}`,
  `CLINIDESK_GATEWAY_URL=http://host.docker.internal:${DASH_PORT}`,
  `CLINIDESK_GATEWAY_SECRET=${GATEWAY_SECRET}`,
  `CLINIDESK_CRON_SECRET=${CRON_SECRET}`,
  `SUPABASE_URL=http://host.docker.internal:54321`,
  `SUPABASE_SERVICE_ROLE_KEY=${supa.SERVICE_ROLE_KEY}`,
  `CLINIC_TIMEZONE=${TZ}`,
  `GENERIC_TIMEZONE=${TZ}`,
  "N8N_BLOCK_ENV_ACCESS_IN_NODE=false",
  "WHATSAPP_NUMBER_PROFILE=test",
  "N8N_DIAGNOSTICS_ENABLED=false",
  "N8N_PERSONALIZATION_ENABLED=false",
  "EXECUTIONS_DATA_SAVE_ON_SUCCESS=none",
].join("\n") + "\n", { mode: 0o600 });
const n8nRunEnv = ["--env-file", envFile];

function cleanupN8n() {
  try { sh("docker", ["rm", "-f", N8N_NAME]); } catch {}
  try { sh("docker", ["volume", "rm", "-f", N8N_VOLUME]); } catch {}
}
cleanupN8n();
sh("docker", ["volume", "create", N8N_VOLUME]);
const cli = (...args) =>
  sh("docker", ["run", "--rm", "-v", `${N8N_VOLUME}:/home/node/.n8n`, "-v", `${stage}:/import:ro`, ...n8nRunEnv, N8N_IMAGE, ...args]);
cli("import:credentials", "--input=/import/credentials.json");
cli("import:workflow", "--separate", "--input=/import/workflows");
sh("docker", [
  "run", "--rm", "-v", `${N8N_VOLUME}:/home/node/.n8n`, ...n8nRunEnv, "--entrypoint", "sh", N8N_IMAGE, "-c",
  'for id in "$@"; do n8n publish:workflow --id="$id" >/dev/null 2>&1 || { echo "publish failed: $id"; exit 1; }; done',
  "sh", ...manifest.map((m) => m.id),
]);
sh("docker", [
  "run", "-d", "--name", N8N_NAME, "-p", `127.0.0.1:${N8N_PORT}:5678`, "--add-host", "host.docker.internal:host-gateway",
  "-v", `${N8N_VOLUME}:/home/node/.n8n`, ...n8nRunEnv, N8N_IMAGE,
]);

async function finish(code) {
  try {
    process.kill(-dashboard.pid, "SIGTERM");
  } catch {
    dashboard.kill("SIGTERM");
  }
  llmServer.close();
  graphServer.close();
  rmSync(path.join(ROOT, ".e2e"), { recursive: true, force: true });
  if (!process.env.KEEP) cleanupN8n();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed; replies via ${graphMode === "real" ? "the Meta test number" : "a mock Graph"}.`);
  if (failed.length && process.env.DEBUG) {
    console.log("--- dashboard log (tail) ---\n" + dashLog.join("").split("\n").slice(-60).join("\n"));
    try { console.log("--- n8n log (tail) ---\n" + sh("docker", ["logs", "--tail", "60", N8N_NAME])); } catch {}
  }
  process.exit(code ?? (failed.length ? 1 : 0));
}

try {
  const up = await poll(async () => {
    // n8n is ready only once the agent's webhook is registered (it answers
    // 200 to anything; a request without the gateway secret is dropped).
    const [d, n] = await Promise.all([
      fetch(`http://127.0.0.1:${DASH_PORT}/api/health`).then((r) => r.status).catch(() => 0),
      fetch(`http://127.0.0.1:${N8N_PORT}/webhook/clinidesk-inbound`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
        .then((r) => r.status)
        .catch(() => 0),
    ]);
    return d && n === 200 ? true : null;
  }, { timeout: 120_000, every: 2000 });
  step("local dashboard and throwaway n8n are up", Boolean(up));
  if (!up) await finish(1);

  // --- Signed WhatsApp message, as Meta would send it ---------------------------
  let seq = 0;
  async function patientSays(text) {
    seq += 1;
    const payload = {
      object: "whatsapp_business_account",
      entry: [{
        id: "e2e-local-waba",
        changes: [{
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "15550000000", phone_number_id: PHONE_ID },
            contacts: [{ profile: { name: "E2E Local Patient" }, wa_id: PATIENT }],
            messages: [{ from: PATIENT, id: `wamid.e2elocal.${Date.now()}.${seq}`, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }],
          },
        }],
      }],
    };
    const raw = JSON.stringify(payload);
    const signature = "sha256=" + createHmac("sha256", APP_SECRET).update(raw).digest("hex");
    const res = await fetch(`http://127.0.0.1:${DASH_PORT}/api/whatsapp/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signature },
      body: raw,
    });
    if (res.status !== 200) console.log(`  webhook answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.status;
  }

  const staff = await rest(`staff?clinic_id=eq.${CLINIC}&select=id`);
  async function notes(type) {
    return rest(`notifications?clinic_id=eq.${CLINIC}&patient_phone=eq.${PATIENT}&event_type=eq.${type}&select=staff_id,body`);
  }

  // 1. Book.
  state.expect = "book";
  const accepted = (await patientSays("Assalam o Alaikum, appointment book karni hai")) === 200;
  step("webhook accepted the booking message", accepted);
  if (!accepted) await finish(1);
  const booked = await poll(async () => {
    const rows = await rest(`appointments?clinic_id=eq.${CLINIC}&phone_number=like.*${PATIENT.slice(-10)}&status=in.(booked,confirmed)&select=appointment_id,doctor_id,doctor_name,appointment_date,appointment_time`);
    return rows[0] || null;
  });
  step("n8n booked through Tool - Book Appointment (bot_book_appointment)", Boolean(booked), booked ? `${booked.appointment_date} ${booked.appointment_time}` : `no appointment; LLM calls ${state.llmCalls}, tool calls ${state.toolCalls.map((t) => t.name).join(",") || "none"}`);
  if (!booked) await finish(1);
  if (booked) {
    state.appointmentId = booked.appointment_id;
    const n = await poll(async () => ((await notes("booked")).length ? await notes("booked") : null));
    step("every SmileCare staff member got the 'booked' notification", n?.length === staff.length, `${n?.length ?? 0}/${staff.length}`);
    step("the notification names the patient, doctor, date and time", Boolean(n?.[0]?.body?.includes("Patient: E2E Local Patient") && n[0].body.includes(`Doctor: ${booked.doctor_name}`) && /Date: .+\nTime: .+/.test(n[0].body)));
  }
  const msg = await poll(async () => ((await notes("message")).length ? await notes("message") : null), { timeout: 20_000 });
  step("the patient's message raised a 'message' notification", Boolean(msg?.length));

  // 2. Reschedule.
  state.expect = "reschedule";
  step("webhook accepted the reschedule message", (await patientSays("Mujhe appointment reschedule karni hai")) === 200);
  const moved = await poll(async () => {
    const rows = await rest(`appointments?appointment_id=eq.${state.appointmentId}&select=appointment_date,appointment_time,status`);
    return rows[0] && rows[0].appointment_date === nextWeekday(3) ? rows[0] : null;
  });
  step("n8n rescheduled through Tool - Reschedule Appointment (bot_reschedule)", Boolean(moved), moved ? `${moved.appointment_date} ${moved.appointment_time}` : "date unchanged");
  const r = await poll(async () => ((await notes("rescheduled")).length ? await notes("rescheduled") : null));
  step("staff got the 'rescheduled' notification", Boolean(r?.length));

  // 3. Cancel.
  state.expect = "cancel";
  step("webhook accepted the cancel message", (await patientSays("Please cancel my appointment")) === 200);
  const cancelled = await poll(async () => {
    const rows = await rest(`appointments?appointment_id=eq.${state.appointmentId}&select=status`);
    return rows[0]?.status === "cancelled" ? rows[0] : null;
  });
  step("n8n cancelled through Tool - Cancel Appointment (clinic + phone scoped)", Boolean(cancelled));
  const c = await poll(async () => ((await notes("cancelled")).length ? await notes("cancelled") : null));
  step("staff got the 'cancelled' notification", Boolean(c?.length));

  // Isolation: no other clinic's staff were told anything.
  const leaked = await rest(`notifications?clinic_id=neq.${CLINIC}&patient_phone=eq.${PATIENT}&select=id`);
  step(`no notification reached another clinic (e.g. ${OTHER_CLINIC})`, leaked.length === 0, `${leaked.length} leaked`);

  // Tool calls carried the clinic's doctor and the booked appointment.
  step("the mock LLM drove book, reschedule and cancel tool calls", ["book", "reschedule", "cancel"].every((s) => state.toolCalls.some((t) => t.step === s)), state.toolCalls.map((t) => t.name).join(", "));

  // Replies went out from the clinic's number.
  await sleep(3000);
  const botRows = await rest(`wa_messages?clinic_id=eq.${CLINIC}&patient_wa=eq.${PATIENT}&direction=eq.bot&select=id`);
  if (graphMode === "mock") {
    step("bot replies were sent (mock Graph)", state.graphSends.filter((s) => s.to === PATIENT).length >= 3, `${state.graphSends.length} sent`);
  } else {
    const account = await rest(`whatsapp_accounts?phone_number_id=eq.${PHONE_ID}&select=last_error`);
    step("bot replies were delivered by the Meta test number", botRows.length >= 3, `${botRows.length} delivered${account[0]?.last_error ? `; last Meta error: ${String(account[0].last_error).slice(0, 120)}` : ""}`);
  }

  // 4. Trial ended: no bot reply, no forward.
  sql(`update public.clinics set status = 'trialing', trial_ends_at = now() - interval '1 minute' where clinic_id = ${lit(CLINIC)};`);
  const callsBefore = state.llmCalls;
  state.expect = "book";
  await patientSays("Hello, is anyone there?");
  await sleep(8000);
  step("a clinic whose trial ended gets no AI reply (nothing reached n8n's model)", state.llmCalls === callsBefore);
  const unavailable = await rest(`wa_unavailable_replies?clinic_id=eq.${CLINIC}&select=patient_wa`).catch(() => []);
  step("the patient got the polite 'please call the clinic' reply instead", Array.isArray(unavailable) && unavailable.some((u) => u.patient_wa === PATIENT));
} catch (err) {
  step("run completed without errors", false, err instanceof Error ? err.message.split("\n")[0] : String(err));
} finally {
  // Put SmileCare back the way the seed leaves it.
  try {
    sql(`update public.clinics set status = 'active', trial_ends_at = null, current_period_end = now() + interval '30 days' where clinic_id = ${lit(CLINIC)};
         delete from public.whatsapp_accounts where phone_number_id = ${lit(PHONE_ID)};`);
  } catch {}
  await finish();
}
