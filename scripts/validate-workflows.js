/**
 * Checks every workflow JSON before it can reach production (CI job
 * "Workflow validation"):
 *
 * - each file is valid JSON in n8n's export shape;
 * - deploy/vm/workflows.txt lists files whose fixed top-level ids match, with
 *   no id used twice, so an import updates the existing workflow in place;
 * - every toolWorkflow / executeWorkflow node and every errorWorkflow setting
 *   points at a workflow in this repo;
 * - no hardcoded clinic or doctor id (clinic details come from the gateway);
 * - no literal token, key, secret header, phone number or email address.
 *
 * Run: node scripts/validate-workflows.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const MANIFEST = 'deploy/vm/workflows.txt';

// The platform owner's alert address, in the error handler's email node. It is
// public on purpose (the dashboard's PLATFORM_ALERT_EMAIL).
const ALLOWED_EMAILS = new Set(['ahtasham067@gmail.com']);

const FORBIDDEN = [
  [/\bCLINIC-[A-Z0-9][A-Z0-9-]*/, 'a hardcoded clinic id'],
  [/\bDOC-\d+\b/, 'a hardcoded doctor id'],
  [/\bEAA[A-Za-z0-9]{20,}/, 'a Meta access token'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'a JWT (Supabase key?)'],
  [/\bsb_(secret|publishable)_[A-Za-z0-9_-]{10,}/, 'a Supabase API key'],
  [/\bgsk_[A-Za-z0-9]{20,}/, 'a Groq API key'],
  [/\bsk-[A-Za-z0-9_-]{20,}/, 'an OpenAI-style API key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/(?<![\w-])\+?92\d{10}(?![\w-])/, 'a Pakistani phone number'],
  [/(?<![\w.-])\+\d{10,15}(?![\w-])/, 'a phone number'],
];

// Header or query parameters that must come from an expression ($env, a
// credential, a previous node), never from a literal value.
const SECRET_PARAM = /secret|token|key|password|authorization|signature/i;

let failed = 0;
function check(ok, pass, fail) {
  if (ok) {
    console.log(`PASS  ${pass}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${fail}`);
  }
}

function strings(value, at, out) {
  if (typeof value === 'string') out.push([at, value]);
  else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${at}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) strings(v, at ? `${at}.${k}` : k, out);
  }
  return out;
}

function refId(ref) {
  if (typeof ref === 'string') return ref.replace(/^=/, '');
  if (ref && typeof ref === 'object') return String(ref.value ?? '');
  return '';
}

const files = fs
  .readdirSync(root)
  .filter((f) => f.endsWith('.json') && !/^package(-lock)?\.json$/.test(f))
  .sort();

const workflows = new Map();
for (const file of files) {
  let wf;
  try {
    wf = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  } catch (err) {
    check(false, '', `${file}: not valid JSON (${err.message})`);
    continue;
  }
  const shaped = Array.isArray(wf.nodes) && wf.connections && typeof wf.connections === 'object';
  check(shaped, `${file}: valid workflow JSON`, `${file}: no nodes/connections, not an n8n workflow export`);
  if (shaped) workflows.set(file, wf);
}

// Fixed ids, unique, and matching the deploy manifest.
const ids = new Map();
for (const [file, wf] of workflows) {
  if (!wf.id) continue;
  check(!ids.has(wf.id), `${file}: id ${wf.id} is unique`, `${file}: id ${wf.id} is also used by ${ids.get(wf.id)}`);
  ids.set(wf.id, file);
}

const manifest = fs
  .readFileSync(path.join(root, MANIFEST), 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'))
  .map((line) => {
    const space = line.indexOf(' ');
    return { id: line.slice(0, space), file: line.slice(space + 1) };
  });

const listed = new Set();
for (const { id, file } of manifest) {
  listed.add(file);
  const wf = workflows.get(file);
  check(Boolean(wf), `${MANIFEST}: ${file} exists`, `${MANIFEST}: ${file} is not a workflow file in the repo`);
  if (wf) check(wf.id === id, `${file}: id matches the manifest`, `${file}: id ${wf.id || '(none)'} but ${MANIFEST} says ${id}`);
}
for (const [file, wf] of workflows) {
  if (wf.id && !listed.has(file)) {
    check(false, '', `${file} has a fixed id but is missing from ${MANIFEST}, so it would never deploy`);
  }
}

// References between workflows.
for (const [file, wf] of workflows) {
  for (const n of wf.nodes) {
    if (!/\.(toolWorkflow|executeWorkflow)$/.test(n.type || '')) continue;
    const target = refId((n.parameters || {}).workflowId);
    if (!target) continue;
    check(ids.has(target), `${file}: "${n.name}" calls ${ids.get(target)}`, `${file}: "${n.name}" calls workflow ${target}, which is not in this repo`);
  }
  const errorWorkflow = (wf.settings || {}).errorWorkflow;
  if (errorWorkflow) {
    check(ids.has(errorWorkflow), `${file}: error workflow ${errorWorkflow} is in the repo`, `${file}: error workflow ${errorWorkflow} is not in this repo`);
  }
}

// Hardcoded clinic data and secrets.
for (const [file, wf] of workflows) {
  let clean = true;
  for (const [at, text] of strings(wf, '', [])) {
    if (/(^|\.)(id|webhookId|versionId|instanceId)$/.test(at)) continue;
    for (const [pattern, what] of FORBIDDEN) {
      if (pattern.test(text)) {
        clean = false;
        check(false, '', `${file}: ${at} contains ${what}`);
      }
    }
    for (const email of text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []) {
      if (!ALLOWED_EMAILS.has(email)) {
        clean = false;
        check(false, '', `${file}: ${at} contains the email address ${email}`);
      }
    }
  }
  for (const n of wf.nodes) {
    for (const [at, param] of strings(n.parameters || {}, '', [])) {
      if (!/\.name$/.test(at) || !SECRET_PARAM.test(param)) continue;
      const valueAt = at.replace(/\.name$/, '.value');
      const value = strings(n.parameters, '', []).find(([p]) => p === valueAt);
      if (value && value[1] && !value[1].startsWith('=')) {
        clean = false;
        check(false, '', `${file}: "${n.name}" sends ${param} as a literal value, not an expression`);
      }
    }
  }
  if (clean) console.log(`PASS  ${file}: no clinic ids, tokens, phone numbers or emails`);
}

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll workflow checks passed.');
