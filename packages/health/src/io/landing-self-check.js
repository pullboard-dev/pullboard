/** Landing notices its own broken checks: a main comparison that never goes green, a stop that keeps repeating [C7]. */

const WINDOW = 20;
const REPEATS = 3;

/** One line of at most 200 characters, the way a shout quotes output. */
function oneLine(text) {
  return String(text ?? '').split('\n').find(line => line.trim())?.trim().slice(0, 200) ?? '';
}

/** Whether this exact shout key was already recorded, so a standing fault is shouted once. */
function alreadyShouted(board, key) {
  return Boolean(board.db.prepare("SELECT 1 FROM event WHERE event_kind='shout' AND event_by='sentinel' AND event_detail LIKE ? LIMIT 1")
    .get(`%"selfCheck":${JSON.stringify(key)}%`));
}

/** Record one blocker shout to the coordinator, keyed so it is never repeated; the caller hands in the board's insertShout so this cell takes no new cross-cell edge. */
function shoutOnce(board, insertShout, key, text) {
  if (alreadyShouted(board, key)) return false;
  insertShout(board, { from: 'sentinel', to: 'coordinator', text, lanes: [], detail: { kind: 'blocker', selfCheck: key } });
  return true;
}

/**
 * Shout when the last 20 main comparisons include no green result. The failing check is the first failed test file
 * and its first output line, which is the recorded first error when the receipt kept one.
 *
 * @param {object} board
 * @param {object[]} receipts gate receipts, any kind; only main-red comparisons count
 * @param {{insertShout: Function}} ports the board's shout writer
 * @returns {boolean} whether a new shout was recorded
 */
export function mainComparisonAlarm(board, receipts, { insertShout }) {
  const recent = receipts.filter(receipt => receipt?.kind === 'main-red')
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at)).slice(0, WINDOW);
  if (recent.length < WINDOW || recent.some(receipt => receipt.green)) return false;
  const failure = recent.flatMap(receipt => receipt.failures ?? [])[0];
  const signature = recent.flatMap(receipt => receipt.failureSignatures?.failures ?? []).find(row => row.firstError);
  const check = failure?.file ?? 'main comparison';
  const first = oneLine(signature?.firstError ?? failure?.name ?? 'no failing test was recorded');
  return shoutOnce(board, insertShout, `main-red:${recent[0].id}`,
    `Main comparisons: none of the last ${WINDOW} was green. Failing check ${check}: ${first}`);
}

/**
 * Shout when the same landing stop reason ends 3 batches in a row, naming the reason and the item or file it names.
 *
 * @param {object} board
 * @param {{insertShout: Function, landingBatches: Function}} ports the board's shout writer and batch reader
 * @returns {boolean} whether a new shout was recorded
 */
export function repeatedStopAlarm(board, { insertShout, landingBatches }) {
  const last = landingBatches(board).slice(-REPEATS);
  if (last.length < REPEATS) return false;
  const stops = last.map(batch => {
    const code = batch.refusal?.code ?? batch.state;
    if (!code || ['landed', 'ready', 'running'].includes(code)) return null;
    const subject = batch.refusal?.item ?? batch.refusal?.file ?? batch.failures?.[0]
      ?? batch.culprits?.[0]?.id ?? batch.blocked?.[0]?.id ?? batch.items?.[0]?.id;
    return { code, subject: typeof subject === 'number' ? `#${subject}` : String(subject ?? 'no item named') };
  });
  if (stops.some(stop => !stop) || stops.some(stop => stop.code !== stops[0].code)) return false;
  const { code, subject } = stops[0];
  return shoutOnce(board, insertShout, `stop:${code}:${subject}`, `Landing stopped ${REPEATS} batches in a row for ${code}; it names ${subject}`);
}
