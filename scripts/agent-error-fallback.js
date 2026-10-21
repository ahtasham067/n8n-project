// n8n Code node: Agent Error Fallback — salvage tool results; never fake confirmations.
const config = $('Dental Clinic Config').first().json;
const userMsg = String(config.message_text || '');
const userLower = userMsg.toLowerCase();
const err = String(
  $json.error || $json.message || $json.description || '',
).trim();

function toolItems(nodeName) {
  const results = [];
  const seen = new Set();

  function addJson(json) {
    if (!json || typeof json !== 'object') return;
    const key = JSON.stringify(json);
    if (seen.has(key)) return;
    seen.add(key);
    results.push(json);
  }

  // AI tool sub-workflows only emit on ai_tool (output index 0). This Code node
  // is not downstream of those tools, so .all() without branchIndex returns [].
  for (let runIndex = 0; runIndex < 20; runIndex += 1) {
    let found = false;
    try {
      const items = $(nodeName).all(0, runIndex);
      if (!items?.length) break;
      found = true;
      for (const item of items) addJson(item.json);
    } catch {
      if (!found) break;
    }
  }

  // Fallback when this node is wired after a tool on main output.
  try {
    for (const item of $(nodeName).all()) addJson(item.json);
  } catch {
    // ignore
  }

  return results;
}

function latestToolSuccess(nodeName) {
  const items = toolItems(nodeName);
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i]?.success === true) return items[i];
  }
  return null;
}

function latestToolWithMessage(nodeName) {
  const items = toolItems(nodeName);
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i]?.message) return items[i];
  }
  return null;
}

function bookSuccess() {
  return latestToolSuccess('BookAppointment');
}

function rescheduleSuccess() {
  return latestToolSuccess('RescheduleAppointment');
}

function cancelAllResult() {
  return latestToolWithMessage('CancelAllAppointments');
}

function cancelResults() {
  return toolItems('CancelAppointment');
}

function getAppointmentResult() {
  const items = toolItems('GetAppointment');
  return items.length ? items[items.length - 1] : null;
}

function availabilityResults() {
  return toolItems('CheckDoctorAvailability').filter((j) => j && j.success === true);
}

function isRateLimit(text) {
  return /rate limit|too many requests|429|tpm|tokens per min|rate_limit_exceeded/i.test(
    text,
  );
}

function rateLimitMessage() {
  return "I'm handling many requests right now. Please wait about 15 seconds and send your message again.";
}

function genericFailure() {
  if (/book|slot|time|\d{1,2}:\d{2}|pm|am/i.test(userMsg)) {
    return "I couldn't complete the booking. Please pick another available slot, or ask me to show availability again.";
  }
  if (/cancel/i.test(userLower)) {
    return "I couldn't complete the cancellation. Please try again in a moment, or tell me which appointment to cancel.";
  }
  if (/reschedule|change|move/i.test(userLower)) {
    return "I couldn't complete the rescheduling. Please try again or tell me your preferred new date and time.";
  }
  if (/show|my appointment|booked|confirm|status|again/i.test(userLower)) {
    return "I couldn't look up your appointments right now. Please try again in a moment.";
  }
  return "I'm sorry, I couldn't complete that request. Please try again in a moment.";
}

// 1) Successful booking — only true confirmation path
const booked = bookSuccess();
if (booked?.message) {
  return [{ json: { output: booked.message } }];
}

// 2) Successful reschedule
const rescheduled = rescheduleSuccess();
if (rescheduled?.message) {
  return [{ json: { output: rescheduled.message } }];
}

// 3) Cancel all tool (single call, multiple cancels inside workflow)
const cancelAll = cancelAllResult();
if (cancelAll?.message) {
  return [{ json: { output: cancelAll.message } }];
}

// 4) Individual cancel attempts
const cancels = cancelResults();
if (cancels.length) {
  const ok = cancels.filter((j) => j.success === true);
  const fail = cancels.filter((j) => j.success === false);
  const lines = [];
  for (const c of ok) {
    if (c.message) lines.push(c.message);
  }
  for (const c of fail) {
    if (c.message) lines.push(c.message);
  }
  if (lines.length) {
    return [{ json: { output: lines.join('\n\n') } }];
  }
}

// 5) Failed booking attempts — relay tool message, never confirm
const bookFails = toolItems('BookAppointment').filter((j) => j && j.success === false);
if (bookFails.length) {
  const last = bookFails[bookFails.length - 1];
  if (last.message) {
    return [{ json: { output: last.message } }];
  }
}

// 6) Lookup / status queries
const lookup = getAppointmentResult();
if (lookup) {
  if (lookup.found === false && lookup.message) {
    return [{ json: { output: lookup.message } }];
  }
  if (
    lookup.found === true &&
    lookup.message &&
    /show|my|booked|appointment|confirm|status|again|cancel|list/i.test(userLower)
  ) {
    return [{ json: { output: lookup.message } }];
  }
}

// 7) Availability-only turn salvage (no booking attempted)
const avail = availabilityResults();
const bookAttempted = toolItems('BookAppointment').length > 0;
if (avail.length && !bookAttempted && !cancels.length && !cancelAll) {
  const last = avail[avail.length - 1];
  if (last.available_slots_display?.length && last.message) {
    const numbered = last.available_slots_display
      .map((t, i) => `${i + 1}. ${t}`)
      .join('\n');
    return [
      {
        json: {
          output: `Available slots for ${last.date_display || last.date}:\n\n${numbered}\n\nReply with a slot number or time (e.g. 1:30 PM) to book.`,
        },
      },
    ];
  }
}

// 8) Groq / LLM rate limit — only when no tool result was salvaged above
if (isRateLimit(err)) {
  return [{ json: { output: rateLimitMessage() } }];
}

// 9) Generic failure
return [{ json: { output: genericFailure() } }];
