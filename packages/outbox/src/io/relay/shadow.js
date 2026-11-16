/** The relay outbox writer's shadow compare: the outbox table decides each queue and park beside the writer, and with moves.shadow on the compare is recorded on the board [C7,#8389]. */
import { firstDifference } from '../../../../store/index.js';
import { recordShadow } from '../../../../store/index.js';

/** The outbox table's decision, handed in by the app: `(snapshot, move) => answer`. Why provided: the outbox cell sits below moves, so the app that composes both injects it. */
let decide = null;
/** The moves.shadow machine setting, handed in with the table because this cell may not read config. */
let enabled = () => false;

/** The moves.live.outbox machine setting, handed in with the table for the same reason. */
let liveEnabled = () => false;

/**
 * Provide the outbox table the writer's shadow and live paths decide with, once per process.
 *
 * @param {((snapshot: object, move: object) => { refused?: object, patch?: { outbox: object } }) | null} table
 * @param {() => boolean} [on] - Reads the moves.shadow machine setting; the shadow stays off without it.
 * @param {() => boolean} [live] - Reads the moves.live.outbox machine setting; the writer keeps its own rules without it.
 */
export function provideOutboxTable(table, on = () => false, live = () => false) {
  decide = typeof table === 'function' ? table : null;
  enabled = typeof on === 'function' ? on : () => false;
  liveEnabled = typeof live === 'function' ? live : () => false;
}

/** Whether the writer runs the table at all: a provided table and the setting on. Read once per move, so an off machine pays one call. */
export function outboxShadowing() {
  try { return decide !== null && enabled() === true; } catch { return false; }
}

/** The queued-move counts the table reasons about, read off an outbox document; no document is an empty outbox. */
export function outboxCounts(outbox) {
  const moves = outbox?.moves?.length ?? 0;
  const parked = outbox?.moves?.filter(entry => entry.parked).length ?? 0;
  return { moves, parked, state: moves === 0 ? 'none' : parked === moves ? 'parked' : 'queued' };
}

/**
 * Where the table's answer and the writer's outbox part: `refused` when the table refuses a move the writer made, `threw` when it threw,
 * else the first differing field of the counts, or null when they agree.
 */
export function outboxDiffers(answer, wrote) {
  if (answer?.threw) return `threw ${answer.threw}`;
  if (answer?.refused) return 'refused';
  const { moves, parked, state } = answer?.patch?.outbox ?? {};
  return firstDifference({ moves, parked, state }, wrote, 'outbox');
}

/**
 * Compare the outbox table with what the writer just did to the outbox, and record the compare under the `outbox` table on the board.
 * Why it never throws and never waits for the table: the writer stays the authority while a table is shadowed, so a fault here must not refuse a move.
 * The table sees the outbox as it stood before (nothing sent, nothing acknowledged: the writer keeps no per-move send record), and the move's name.
 *
 * @param {{ root: string, localRecords: (root: string, work: (board: object) => unknown) => unknown }} link
 * @param {'queue' | 'park'} name
 * @param {object | null | undefined} before - The outbox document before the move.
 * @param {object | null | undefined} after - The outbox document after the move.
 * @param {string} id - The queued move's id.
 */
export function shadowOutbox(link, name, before, after, id) {
  if (!outboxShadowing()) return;
  try {
    const was = outboxCounts(before);
    const snapshot = { outbox: { ...was, baseSequence: before?.baseSequence ?? after?.baseSequence ?? 0, sent: 0, receipted: 0, remade: 0 }, board: { sequence: before?.baseSequence ?? after?.baseSequence ?? 0 } };
    let answer;
    try { answer = decide(snapshot, { name }); } catch (error) { answer = { threw: error?.code ?? String(error?.message ?? error) }; }
    const differs = outboxDiffers(answer, outboxCounts(after));
    link.localRecords(link.root, board => recordShadow(board, 'outbox', id, differs));
  } catch { /* A recording fault leaves the move as the writer made it. */ }
}

/**
 * What the outbox table decides for a queue or park when moves.live.outbox is on: null when it is off or no table is provided,
 * else the table's `{ refused }` or the `{ state }` it names. The table reads the outbox as it stood before the move [C7,#8391].
 *
 * @param {'queue' | 'park'} name
 * @param {object | null | undefined} before - The outbox document before the move.
 * @returns {{ refused: { code: string, message: string, next?: string } } | { state: string } | null}
 */
export function liveDecision(name, before) {
  let on = false;
  try { on = decide !== null && liveEnabled() === true; } catch { on = false; }
  if (!on) return null;
  const base = before?.baseSequence ?? 0;
  const answer = decide({ outbox: { ...outboxCounts(before), baseSequence: base, sent: 0, receipted: 0, remade: 0 }, board: { sequence: base } }, { name });
  return answer.refused ? { refused: answer.refused } : { state: answer.patch.outbox.state };
}
