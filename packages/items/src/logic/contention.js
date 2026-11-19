import { itemFiles } from './files.js';
import { conflictNoteFiles } from './reopen/cause.js';
import { reopenConflictEvidence } from './reopen/cause.js';

/** An item holds a file in flight while it is claimed, submitted, or verified and not yet merged. */
const inFlightNow = item => item.item_status === 'claimed' || item.item_status === 'submitted'
  || (item.item_status === 'verified' && !item.item_merged_commit);

/**
 * Score each candidate by file contention: for each file it names, that file's recent conflict rate times the changes
 * in flight on it now (other items only); an item's score is its worst file, and that file is named so a wait can say
 * what it waits on [C7,#8527].
 * Why the worst file: one hot file is enough to collide, however quiet the item's other files are.
 *
 * @param {any[]} candidates open items to score
 * @param {any[]} inFlight board items whose item_files already carry any observed working files
 * @param {Map<string, number>} rates conflict count per file over the recent window
 * @returns {Map<number, { score: number, file: string | null }>}
 */
export function contentionScores(candidates, inFlight, rates) {
  const flying = new Map();
  for (const other of inFlight) {
    if (!inFlightNow(other)) continue;
    for (const file of new Set(itemFiles(other))) flying.set(file, (flying.get(file) ?? 0) + 1);
  }
  return new Map(candidates.map(entry => {
    let best = { score: 0, file: null };
    for (const file of itemFiles(entry)) {
      const score = (rates.get(file) ?? 0) * (flying.get(file) ?? 0);
      if (score > best.score) best = { score, file };
    }
    return [entry.item_id, best];
  }));
}

/**
 * Reorder runs of equal priority by contention score, lowest first, leaving every other position alone.
 * Why runs: priority, route tier and returned work already ordered the list; contention only breaks ties between
 * neighbours that the order treats alike.
 *
 * @param {any[]} list candidates in their current order, each { entry }
 * @param {(candidate: any) => string} keyOf the equal-priority key; a unique key keeps its item in place
 * @param {Map<number, { score: number }>} scores from contentionScores
 * @returns {void} reorders the list in place
 */
export function orderByContention(list, keyOf, scores) {
  let start = 0;
  while (start < list.length) {
    let end = start + 1;
    while (end < list.length && keyOf(list[end]) === keyOf(list[start])) end++;
    const run = list.slice(start, end).sort((a, b) => scores.get(a.entry.item_id).score - scores.get(b.entry.item_id).score);
    list.splice(start, run.length, ...run);
    start = end;
  }
}

const WINDOW_MS = 14 * 86_400_000;

/**
 * How often each file was named by a conflict reopen or conflict hold in the last 14 days.
 * Why here and not the rigor report: that report also builds advice and splits, and next needs only the counts; both
 * read the same conflict evidence, so a file's rate here equals its reopens plus holds there.
 *
 * @param {any[]} events reopen and hold_item events, oldest first
 * @param {Date} now
 * @returns {Map<string, number>}
 */
export function conflictRates(events, now) {
  const until = new Date(now).getTime();
  const rates = new Map();
  const seen = new Set();
  for (const event of events) {
    const at = Date.parse(event.event_at);
    if (!Number.isInteger(event.item_id) || event.item_id < 1 || !Number.isFinite(at) || at < until - WINDOW_MS || at > until || seen.has(event.event_id)) continue;
    seen.add(event.event_id);
    const detail = JSON.parse(event.event_detail);
    const files = event.event_kind === 'reopen' ? reopenConflictEvidence(detail)?.files : event.event_kind === 'hold_item' ? conflictNoteFiles(detail.reason) : null;
    for (const file of files ?? []) rates.set(file, (rates.get(file) ?? 0) + 1);
  }
  return rates;
}

/**
 * The files that are quiet: their recent conflict rate is under the threshold [C7,#11084].
 *
 * A file with no recorded rate has never conflicted, so it is quiet. Why a pure filter: the caller
 * passes the rates from conflictRates and the queue.contentionThreshold setting, so this reads no board.
 *
 * @param {string[]} files - Candidate file paths.
 * @param {Map<string, number>} rates - Conflict count per file over the recent window.
 * @param {number} threshold - A file at or over this rate is not quiet.
 * @returns {string[]} The quiet files, in the order given.
 */
export function quietFiles(files, rates, threshold) {
  return files.filter(file => (rates.get(file) ?? 0) < threshold);
}
