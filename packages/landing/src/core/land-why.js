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
 * A failure is 'also red on main' when the same file and case failed in another recorded batch that
 * carried different items, since a failure that follows no item is main's; otherwise it is 'batch only'.
 * @param {{db:{prepare:Function}}} board
 * @param {Date} now
 * @returns {object}
 */
export function landWhy(board, now = new Date()) {
  const latest = new Map();
  const failed = new Map();
  for (const row of board.db.prepare("SELECT event_detail FROM event WHERE event_kind='landing_batch' ORDER BY event_id").all()) {
    const { batch } = detailOf(row);
    if (!batch?.id) continue;
    latest.set(batch.id, batch);
    const key = idsOf(batch.items).sort((left, right) => left - right).join(',');
    for (const result of batch.gateResults ?? []) for (const failure of result.failures ?? []) {
      const id = `${failure.file}\u0000${failure.name}`;
      if (!failed.has(id)) failed.set(id, new Set());
      failed.get(id).add(`${batch.id}:${key}`);
    }
  }
  const batches = [...latest.values()];
  const batch = batches.at(-1) ?? null;
  const merged = board.db.prepare("SELECT item_id,event_at FROM event WHERE event_kind='merged' ORDER BY event_id DESC LIMIT 1").get();
  const since = new Date(now.getTime() - HOUR_MS).toISOString();
  const count = kind => board.db.prepare('SELECT COUNT(*) AS n FROM event WHERE event_kind=? AND event_at>=?').get(kind, since).n;
  const failures = [];
  for (const result of batch?.gateResults ?? []) for (const failure of result.failures ?? []) {
    const own = idsOf(batch.items).sort((left, right) => left - right).join(',');
    const elsewhere = [...failed.get(`${failure.file}\u0000${failure.name}`) ?? []].some(entry => entry.slice(entry.indexOf(':') + 1) !== own);
    failures.push({ file: failure.file, name: failure.name, assertion: failure.assertion ?? null, scope: elsewhere ? 'also red on main' : 'batch only' });
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
