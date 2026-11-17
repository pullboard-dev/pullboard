/** Judge each recorded move by whether the released table, the current table, both or neither answered as the board did [C7]. */
import { difference } from './replay.js';
import { recordedOutcome } from './replay.js';

/** The answer for one event id, from a Map or a plain object keyed by id; undefined when none was given. */
function answerFor(answers, id) {
  if (answers instanceof Map) return answers.get(id);
  return answers?.[id];
}

/** True when an answer exists and agrees with the recorded outcome in decision, code and events. */
function matches(recorded, answer) {
  return Boolean(recorded) && Boolean(answer) && difference(recorded, answer) === null;
}

/** Order event ids numbers first, then text, so rows never depend on the order records arrived in. */
function byEvent(a, b) {
  const [x, y] = [a.event, b.event];
  if (typeof x === 'number' && typeof y === 'number') return x - y;
  if (typeof x === 'number') return -1;
  if (typeof y === 'number') return 1;
  return String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0;
}

const CLASSES = {
  both: 'same',
  releasedOnly: 'current-drifted',
  currentOnly: 'released-wrong',
  neither: 'both-differ'
};

/**
 * Sort each recorded move into one class by what the two tables answered against what the board wrote:
 * `same` (both match), `current-drifted` (only the released table matches), `released-wrong` (only the current table matches),
 * `both-differ` (neither). A record with no readable recorded decision, or no answer from a table, matches nothing.
 * Why: a table change must not grade itself; the previous release's answers are the second opinion.
 * Pure: reads no clock, file or git, and gives the same rows in any input order.
 *
 * @param {{ event: { id: number | string }, recorded: { refused: string } | { events: object[] } }[]} records
 * @param {Map<number | string, object> | Record<string, object>} releasedAnswers - By event id, `{ decision: 'refused', code }` or `{ decision: 'accepted', events }`.
 * @param {Map<number | string, object> | Record<string, object>} currentAnswers - Same shape, from the current tables.
 * @returns {{ rows: { event: number | string, class: string, recorded: object | null, released: object | null, current: object | null }[],
 *   counts: { same: number, currentDrifted: number, releasedWrong: number, bothDiffer: number } }}
 */
export function judgeRecords(records, releasedAnswers, currentAnswers) {
  const rows = [];
  const counts = { same: 0, currentDrifted: 0, releasedWrong: 0, bothDiffer: 0 };
  for (const record of records ?? []) {
    const id = record?.event?.id;
    const recorded = recordedOutcome(record?.recorded);
    const released = answerFor(releasedAnswers, id) ?? null;
    const current = answerFor(currentAnswers, id) ?? null;
    const releasedOk = matches(recorded, released);
    const currentOk = matches(recorded, current);
    const cls = releasedOk ? (currentOk ? CLASSES.both : CLASSES.releasedOnly) : (currentOk ? CLASSES.currentOnly : CLASSES.neither);
    const key = { [CLASSES.both]: 'same', [CLASSES.releasedOnly]: 'currentDrifted', [CLASSES.currentOnly]: 'releasedWrong', [CLASSES.neither]: 'bothDiffer' }[cls];
    counts[key]++;
    rows.push({ event: id, class: cls, recorded, released, current });
  }
  rows.sort(byEvent);
  return { rows, counts };
}
