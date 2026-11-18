/** Replay a move table over recorded moves and list every disagreement with what the board wrote [C7,#8069]. */
import { isDeepStrictEqual } from 'node:util';
import { Refused } from '../../../../kernel/light.js';
import { runTable } from './run.js';

/** As the board stores it: JSON drops undefined keys, so both sides are compared after the same round trip. */
const stored = (value) => JSON.parse(JSON.stringify(value));

/** One outcome in the words a disagreement reports: a refusal by its code, or an acceptance with the events written. */
const refusal = (code) => ({ decision: 'refused', code });
const acceptance = (events) => ({ decision: 'accepted', events: stored(events) });

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Run a table over recorded moves, one record at a time, and report who agrees.
 * A record is `{ event: { id, at }, snapshot, move, recorded }`, where `recorded` is the decision and detail the board wrote:
 * `{ refused: code }` or `{ events: [...] }`. Agreement is the same decision and, for an acceptance, the same events word for word.
 * Records stamped before `cut` (the 0.9.4 snapshot cut, passed in, never read from a clock) are counted before-cut and never replayed,
 * since their snapshots predate the shape the table reads. A record that is malformed, or whose snapshot makes the rules throw, is not replayable and is listed with why.
 * Why: a table is trusted only once it reproduces what the board really decided, and every difference must be findable by its event id.
 *
 * @param {import('./run.js').MoveTable} table
 * @param {Readonly<Record<string, object>>} rules - From defineRules.
 * @param {{ event: { id: number | string, at: string | number }, snapshot: object, move: object, recorded: { refused: string } | { events: object[] } }[]} records
 * @param {{ cut: string | number }} options - `cut`: the instant (ISO text or epoch milliseconds) the replayable records start at.
 * @returns {{ total: number, agreed: number, disagreed: number, notReplayable: number, beforeCut: number,
 *   disagreements: { event: number | string, recorded: object, table: object, differs: 'decision' | 'code' | 'detail' }[],
 *   unreplayable: { event: number | string | null, reason: string }[] }}
 */
export function replayTable(table, rules, records, { cut } = {}) {
  const cutAt = typeof cut === 'number' ? cut : Date.parse(cut);
  if (!Number.isFinite(cutAt)) throw new Refused('REPLAY_CUT', 'replay needs the 0.9.4 cut as a time, and got none that parses', 'pass { cut } as the v0.9.4 tag commit time (ISO text or epoch milliseconds)');
  if (!Array.isArray(records)) throw new Refused('REPLAY_RECORDS', 'replay needs a list of records', 'pass records as an array of { event, snapshot, move, recorded }');
  const report = { total: records.length, agreed: 0, disagreed: 0, notReplayable: 0, beforeCut: 0, disagreements: [], unreplayable: [] };
  const skip = (record, reason) => { report.notReplayable++; report.unreplayable.push({ event: record?.event?.id ?? null, reason }); };
  for (const record of records) {
    const at = typeof record?.event?.at === 'number' ? record.event.at : Date.parse(record?.event?.at);
    if (!isObject(record) || record.event?.id === undefined || !Number.isFinite(at)) { skip(record, 'the record has no event id and time'); continue; }
    if (at < cutAt) { report.beforeCut++; continue; }
    const recorded = recordedOutcome(record.recorded);
    if (!isObject(record.snapshot) || !isObject(record.move) || !recorded) { skip(record, 'the record has no snapshot, move and recorded decision'); continue; }
    let answer;
    try {
      answer = runTable(table, rules, structuredClone(record.snapshot), structuredClone(record.move));
    } catch (error) {
      skip(record, `the rules could not read the snapshot: ${error?.code ?? error?.name ?? 'error'}`);
      continue;
    }
    const mine = answer.refused ? refusal(answer.refused.code) : acceptance(answer.events);
    const differs = difference(recorded, mine);
    if (!differs) { report.agreed++; continue; }
    report.disagreed++;
    report.disagreements.push({ event: record.event.id, recorded, table: mine, differs });
  }
  return report;
}

/** The recorded decision as an outcome, or null when the record names neither a refusal code nor events. */
export function recordedOutcome(recorded) {
  if (isObject(recorded) && typeof recorded.refused === 'string') return refusal(recorded.refused);
  if (isObject(recorded) && Array.isArray(recorded.events)) return acceptance(recorded.events);
  return null;
}

/** How two outcomes differ: the decision, a refusal's code, or the events written; null when they agree. */
export function difference(recorded, mine) {
  if (recorded.decision !== mine.decision) return 'decision';
  if (recorded.decision === 'refused') return recorded.code === mine.code ? null : 'code';
  return isDeepStrictEqual(recorded.events, mine.events) ? null : 'detail';
}
