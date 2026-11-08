/** Why nothing lands: a read-only projection of recorded board events, no test runs and no git [C7]. */

const HOUR_MS = 3_600_000;

/** Parse an event's JSON detail, treating a damaged row as empty rather than failing the screen. */
function detailOf(row) {
  try { return JSON.parse(row.event_detail) ?? {}; } catch { return {}; }
}

/** The ids of a batch's items or blocked entries, whether recorded as numbers or as objects. */
function idsOf(entries) {
  return (entries ?? []).map(entry => (typeof entry === 'object' && entry !== null ? entry.id : entry)).filter(Number.isSafeInteger);
}

/**
 * Project why the train is held from landing_batch, merged and reopen events.
 * A failure is 'also red on main' only when the gate result records it in knownMain (the exact-main comparison);
 * a remaining failure beside that record is 'batch only', and one with no recorded comparison is 'unknown'.
 * @param {{db:{prepare:Function}}} board
 * @param {Date} now
 * @returns {object}
 */
export function landWhy(board, now = new Date()) {
  // Only the newest landing_batch event describes the train now, so one indexed read replaces a scan of all history.
  const newest = board.db.prepare("SELECT event_detail FROM event WHERE event_kind='landing_batch' ORDER BY event_id DESC LIMIT 1").get();
  const batch = newest ? detailOf(newest).batch ?? null : null;
  const merged = board.db.prepare("SELECT item_id,event_at FROM event WHERE event_kind='merged' ORDER BY event_id DESC LIMIT 1").get();
  const since = new Date(now.getTime() - HOUR_MS).toISOString();
  const count = kind => board.db.prepare('SELECT COUNT(*) AS n FROM event WHERE event_kind=? AND event_at>=?').get(kind, since).n;
  const failures = [];
  // The landing writer saves the main comparison on the batch (knownMain, or proof.knownMain); a gate row may carry its own.
  const batchKnown = batch?.knownMain ?? batch?.proof?.knownMain ?? null;
  const seen = new Set();
  const add = (failure, scope) => {
    const key = `${failure.file}\0${failure.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    failures.push({ file: failure.file, name: failure.name, assertion: failure.assertion ?? null, scope });
  };
  for (const result of batch?.gateResults ?? []) {
    const known = result.knownMain ?? result.knownMainProof?.knownMain ?? batchKnown;
    for (const failure of known ?? []) add(failure, 'also red on main');
    // Only a recorded main comparison can call a remaining case batch-only; without one the scope is unknown.
    for (const failure of result.failures ?? []) add(failure, known ? 'batch only' : 'unknown');
  }
  const blocked = (batch?.blocked ?? []).map(entry => ({ id: entry.id, code: entry.code ?? 'BLOCKED' }));
  const tally = new Map();
  for (const entry of blocked) tally.set(entry.code, (tally.get(entry.code) ?? 0) + 1);
  const topBlocker = batch?.state === 'landed' ? null : batch?.refusal?.code ?? [...tally].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
  return { lastLanded: merged ? { item: merged.item_id, at: merged.event_at } : null,
    landedLastHour: count('merged'), reopenedLastHour: count('reopen'),
    batch: batch && { id: batch.id, state: batch.state, startedAt: batch.startedAt ?? null, items: idsOf(batch.items), refusal: batch.refusal?.code ?? null },
    blocked, failures, topBlocker };
}

/** The one landing line `pullboard status` prints. */
export function landingLine(why) {
  return `landing: ${why.landedLastHour} landed, ${why.reopenedLastHour} reopened in the last hour; top blocker: ${why.topBlocker ?? 'none'}`;
}

/** The lines `pullboard land --why` prints. */
export function landWhyLines(why) {
  const lines = [why.lastLanded ? `last landed: #${why.lastLanded.item} at ${why.lastLanded.at}` : 'last landed: nothing yet'];
  if (!why.batch) return [...lines, 'batch: none recorded'];
  lines.push(`batch ${why.batch.id}: ${why.batch.state}${why.batch.startedAt ? ` since ${why.batch.startedAt}` : ''}; items: ${why.batch.items.map(id => `#${id}`).join(', ') || 'none'}; refusal: ${why.batch.refusal ?? 'none'}`);
  for (const entry of why.blocked) lines.push(`blocked: #${entry.id} ${entry.code}`);
  for (const failure of why.failures) lines.push(`failing: ${failure.file} :: ${failure.name} (${failure.scope})`);
  return lines;
}
