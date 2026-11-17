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

/** A release tag: v, then major, minor and patch numbers, and nothing after them. */
const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/u;

/**
 * Pick the last release from a list of tag names: the highest vMAJOR.MINOR.PATCH, each part compared as a number.
 * Prerelease tags (v0.9.5-rc.1), unprefixed ones (0.9.5) and any other name are skipped.
 * Why: "the last released kernel" must be found the same way on every machine; tag creation dates and text order disagree (v0.9.10 sorts before v0.9.9 as text).
 * Pure: reads no clock, file or git, and does not change the list.
 *
 * @param {string[]} tags - Tag names, in any order.
 * @returns {string | null} The highest release tag, or null when no name is a release tag.
 */
export function lastReleaseTag(tags) {
  let best = null;
  let bestParts = null;
  for (const tag of tags ?? []) {
    const match = RELEASE_TAG.exec(String(tag));
    if (!match) continue;
    const parts = match.slice(1).map(Number);
    const at = bestParts ? parts.findIndex((part, i) => part !== bestParts[i]) : 0;
    if (!bestParts || (at >= 0 && parts[at] > bestParts[at])) { best = tag; bestParts = parts; }
  }
  return best;
}

/**
 * Fold per-table judge counts into one release verdict: a row per judged table, the tables the release lacked, the drifted ones and a clean flag.
 * A table drifted when any record is current-drifted or both-differ; released-wrong is never drift, since the current table fixed what the release got wrong.
 * Why: a release script needs one answer for about 15 tables, not 15 row lists.
 * Pure: reads no clock, file or git, gives the same result in any input order and does not change the array.
 *
 * @param {{ table: string, judge?: { against: string, counts: { same: number, currentDrifted: number, releasedWrong: number, bothDiffer: number } }, missing?: boolean }[]} tables
 * @returns {{ rows: { table: string, against: string | null, counts: object }[], newTables: string[], drifted: string[], clean: boolean }}
 */
export function judgeSummary(tables) {
  const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const rows = [];
  const newTables = [];
  const drifted = [];
  for (const entry of tables ?? []) {
    if (entry?.missing || !entry?.judge) { newTables.push(entry?.table); continue; }
    const counts = entry.judge.counts ?? {};
    rows.push({ table: entry.table, against: entry.judge.against ?? null, counts });
    if ((counts.currentDrifted ?? 0) + (counts.bothDiffer ?? 0) > 0) drifted.push(entry.table);
  }
  rows.sort((a, b) => byName(a.table, b.table));
  newTables.sort(byName);
  drifted.sort(byName);
  return { rows, newTables, drifted, clean: drifted.length === 0 };
}
