/** Repeated coordinator instructions suggest board mechanisms, never new authority [C7]. */
const KINDS = Object.freeze({
  assignment: { pattern: /\b(?:claim|take|work on|assigned? to|you own)\s+(?:item\s+)?#\d+/iu,
    mechanism: 'The board assigns the highest-ranked eligible item to a free seat, replacing manual item assignments.' },
  focus: { pattern: /\b(?:focus|prioriti[sz]e|priority|only work on)\b/iu,
    mechanism: 'The board applies the current focus to its eligible queue and dispatches focused work before other work.' },
  freeze: { pattern: /(?<!re-)\bfreeze\b|\b(?:stop|pause)\b|\bhold (?:off|work|claims|submits|submissions)\b/iu,
    mechanism: 'A board freeze blocks the named claims or submissions until the coordinator resumes them, replacing stop-work broadcasts.' },
  'merge-main': { pattern: /\b(?:merge|rebase)\b[^.!?\n]{0,80}\bmain\b/iu,
    mechanism: 'Submit detects a moved main and brings the candidate onto the accepted trunk before running the required proof.' },
  refreeze: { pattern: /\bre-?freeze\b/iu,
    mechanism: 'The board detects a stale frozen policy and routes one explicit refreeze decision to its authorized owner before the builder retries.' },
  routing: { pattern: /\b(?:route|routing|redirect|switch to|instead|release\b[^.!?\n]{0,80}\bthen\b)/iu,
    mechanism: 'The board routes work by lane, dependencies and seat eligibility, preserving notes when it hands an item to the eligible owner.' },
});

/** Classify explicit instruction phrases; a compound instruction can contribute once to each named kind. */
export function coordinatorInstructionKinds(text) {
  return Object.entries(KINDS).filter(([, rule]) => rule.pattern.test(String(text))).map(([kind]) => kind);
}

/** Count only original coordinator messages in a bounded rolling window, retaining their exact shout evidence. */
export function coordinatorInstructionReport(shouts, { now, threshold = 3, windowMs = 7 * 86_400_000 } = {}) {
  const end = new Date(now).getTime();
  if (!Number.isFinite(end) || !Number.isSafeInteger(threshold) || threshold < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1) {
    throw new RangeError('instruction counts need an observation time, positive threshold and window');
  }
  const kinds = Object.entries(KINDS).map(([kind, rule]) => ({ kind, mechanism: rule.mechanism, count: 0, shouts: [] }));
  const seen = new Set();
  for (const shout of shouts) {
    const at = new Date(shout.shout_at).getTime();
    if (shout.shout_from !== 'coordinator' || shout.shout_answers != null || shout.shout_request
      || !Number.isSafeInteger(shout.shout_id) || seen.has(shout.shout_id) || !Number.isFinite(at) || at < end - windowMs || at > end) continue;
    seen.add(shout.shout_id);
    const classified = coordinatorInstructionKinds(shout.shout_text);
    for (const entry of kinds.filter(entry => classified.includes(entry.kind))) {
      entry.count++;
      entry.shouts.push({ id: shout.shout_id, to: shout.shout_to, at: shout.shout_at, text: shout.shout_text });
    }
  }
  return { threshold, windowMs, asOf: new Date(end).toISOString(), kinds };
}
