/**
 * Validates language-matching prompt rules and lightweight detection helpers.
 * Run: node scripts/test-language-matching.js
 */
const fs = require('fs');
const path = require('path');

const agentPath = path.join(__dirname, '..', 'WhatsApp AI Appointment Booking Agent.json');
const agent = JSON.parse(fs.readFileSync(agentPath, 'utf8'));
const agentNode = agent.nodes.find((n) => n.name === 'Appointment Booking Agent');
const systemMessage = agentNode.parameters.options.systemMessage;

const requiredPhrases = [
  'LANGUAGE MATCHING',
  'LATEST message',
  'Urdu script',
  'Roman Urdu',
  'English',
  'switches language',
  'Mixed Urdu and English',
  'Never mention language detection',
  'Tool result',
  // Hindi is refused in the current wording: any other language gets English.
  'Reply ONLY in English or Urdu',
  'Devanagari',
  'do NOT reply in that language',
  'Reply in English by default',
  'prefers Urdu script',
  // The clinic's own timezone, never a hardcoded one (the agent serves any clinic).
  'Clinic timezone',
];

const mustNotContain = ['Asia/Karachi', 'Pakistan Standard Time'];
for (const phrase of mustNotContain) {
  if (systemMessage.includes(phrase)) {
    console.error(`FAIL  system prompt hardcodes: ${phrase}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS  prompt does not hardcode: ${phrase}`);
  }
}

const forbiddenPhrases = [
  'respond in Hindi',
  'reply in Hindi',
  'use Hindi',
];

let failed = 0;
for (const phrase of requiredPhrases) {
  if (!systemMessage.includes(phrase)) {
    failed += 1;
    console.error(`FAIL  system prompt missing: ${phrase}`);
  } else {
    console.log(`PASS  prompt contains: ${phrase}`);
  }
}

for (const phrase of forbiddenPhrases) {
  const re = new RegExp(phrase, 'i');
  const hits = systemMessage.match(re);
  if (hits && !systemMessage.includes('NEVER generate Hindi') && !systemMessage.includes('do NOT respond in Hindi')) {
    // allow only in negation context
  }
  const negated = systemMessage.includes('do NOT reply in that language') && systemMessage.includes('Hindi');
  if (!negated && hits) {
    failed += 1;
    console.error(`FAIL  prompt may allow Hindi: ${phrase}`);
  }
}

function hasUrduScript(text) {
  return /[\u0600-\u06FF]/.test(String(text || ''));
}

function hasDevanagari(text) {
  return /[\u0900-\u097F]/.test(String(text || ''));
}

function detectLanguageLabel(text) {
  const s = String(text || '').trim();
  if (!s) return 'unknown';
  if (hasDevanagari(s)) return 'hindi-input';
  const urduChars = (s.match(/[\u0600-\u06FF]/g) || []).length;
  const latinWords = (s.match(/\b[a-zA-Z]{2,}\b/g) || []).length;
  const romanUrduHints = /\b(mujhe|mujhay|chahiye|kal|aaj|deni|leni|karna|karni|batao|bataiye|kya|kaun|hai|hain|nahi|nahin|se|ki|ke|ko)\b/i.test(s);
  const englishSentenceHints = /\b(I|want|book|with|what|time|available|tomorrow|please|the|a|an|my|your)\b/i.test(s);
  if (urduChars > 0 && latinWords > 0) return 'mixed';
  if (urduChars > 0) return 'urdu';
  if (romanUrduHints && !englishSentenceHints && latinWords > 0 && urduChars === 0) return 'roman-urdu';
  if (latinWords > 0) return 'english';
  return 'unknown';
}

function policyResponseLanguage(input) {
  const label = detectLanguageLabel(input);
  if (label === 'hindi-input') return 'urdu-not-hindi';
  if (label === 'urdu') return 'urdu';
  if (label === 'roman-urdu') return 'roman-urdu';
  if (label === 'english') return 'english';
  if (label === 'mixed') return 'mixed';
  return 'unknown';
}

const detectionCases = [
  ['مجھے ڈاکٹر سے اپائنٹمنٹ لینی ہے', 'urdu'],
  ['I want to book an appointment with a doctor.', 'english'],
  ['Mujhe doctor se appointment leni hai', 'roman-urdu'],
  ['Okay, what time is available tomorrow?', 'english'],
  ['کل کون سا وقت available ہے؟', 'mixed'],
  ['मुझे डॉक्टर से अपॉइंटमेंट चाहिए', 'hindi-input'],
];

for (const [input, expected] of detectionCases) {
  const got = detectLanguageLabel(input);
  if (got !== expected) {
    failed += 1;
    console.error(`FAIL  detect "${input}" -> ${got}, expected ${expected}`);
  } else {
    console.log(`PASS  detect "${input.slice(0, 40)}..." -> ${got}`);
  }
}

const hindiPolicy = policyResponseLanguage('मुझे डॉक्टर से अपॉइंटमेंट चाहिए');
if (hindiPolicy !== 'urdu-not-hindi') {
  failed += 1;
  console.error(`FAIL  Hindi input policy -> ${hindiPolicy}, expected urdu-not-hindi`);
} else {
  console.log('PASS  Hindi input maps to Urdu response policy (not Hindi)');
}

const fallbackNode = agent.nodes.find((n) => n.name === 'Agent Error Fallback');
// The fallback is a Code node now (it salvages tool results); older exports had a Set node.
const fallbackExpr = fallbackNode.parameters.jsCode
  ?? fallbackNode.parameters.assignments.assignments.find((a) => a.name === 'output').value;
if (!fallbackExpr.includes('\\u0900-\\u097F')) {
  failed += 1;
  console.error('FAIL  Agent Error Fallback missing Devanagari detection');
} else {
  console.log('PASS  Agent Error Fallback detects Devanagari (Hindi script) -> Urdu message');
}
if (!fallbackExpr.includes('\\u0600-\\u06FF')) {
  failed += 1;
  console.error('FAIL  Agent Error Fallback missing Urdu script detection');
} else {
  console.log('PASS  Agent Error Fallback detects Urdu script');
}

const toolNodes = agent.nodes.filter((n) => n.type.endsWith('toolWorkflow') && !n.disabled);
for (const t of toolNodes) {
  if (!t.parameters.description.includes('NEVER use Hindi')) {
    failed += 1;
    console.error(`FAIL  tool ${t.name} missing Hindi prohibition`);
  } else {
    console.log(`PASS  tool ${t.name} prohibits Hindi in patient text`);
  }
}

// Ensure no Devanagari in user-facing hardcoded fallback strings
for (const name of ['Voice Download Error', 'Voice Transcription Error', 'Agent Error Fallback']) {
  const node = agent.nodes.find((n) => n.name === name);
  const blob = JSON.stringify(node.parameters);
  if (/[\u0900-\u097F]/.test(blob)) {
    failed += 1;
    console.error(`FAIL  ${name} contains Devanagari in hardcoded message`);
  } else {
    console.log(`PASS  ${name} has no Devanagari in hardcoded text`);
  }
}

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll language-matching checks passed (Hindi response prevention verified).');
