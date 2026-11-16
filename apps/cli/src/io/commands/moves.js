/** The pullboard moves command: each move table's recorded shadow compares, disagreements and state, read-only [C7,#8378]. */
import { loadMachineSettings } from '../../../../../packages/config/index.js';
import { listMoveTables } from '../../../../../packages/moves/index.js';
import { readShadows } from '../../../../../packages/store/index.js';
import { context } from '../context.js';
import { withBoardRead } from '../context.js';

/** Tables whose writer runs the table on every move, whatever the machine settings say. */
const ALWAYS_LIVE = Object.freeze(['release', 'withdraw', 'lease', 'verify', 'landing', 'pulled']);

/** Tables that have no writer by design, so their state reads map rather than none (backbone only today) [C7]. */
export const NO_WRITER = Object.freeze(['backbone']);

/** The table a `*.table.js` path names, such as `claim` for `packages/moves/src/logic/table/claim.table.js`. */
const tableName = path => path.slice(path.lastIndexOf('/') + 1).replace(/\.table\.js$/u, '');

/**
 * The machine setting that puts each table's writer live, by the key its compares are recorded under.
 * Why a map: one switch can govern two recorded tables (moves.live.submit: commit and submit; moves.live.handoff: start and complete) [C7,#9188].
 */
const LIVE_SWITCH = Object.freeze({
  claim: 'moves.live.claim', commit: 'moves.live.submit', submit: 'moves.live.submit', start: 'moves.live.handoff', complete: 'moves.live.handoff',
  outcome: 'moves.live.outcome', job: 'moves.live.job', reopen: 'moves.live.reopen', outbox: 'moves.live.outbox', hop: 'gate.fencedHop',
});

/** Whether a switch is on: a moves.live switch only when set true; gate.fencedHop unless set false, its default being on [C7,#8327]. */
function switchOn(name, settings) {
  if (name === 'gate.fencedHop') return settings.gate?.fencedHop !== false;
  return settings.moves?.live?.[name.slice('moves.live.'.length)] === true;
}

/**
 * One table's state: live when its writer runs the table, shadow when compares are recorded, map when it has no writer by design, else none.
 * Why live wins: once the writer follows the table, a recorded count describes a past window, not the current authority.
 */
function stateOf(table, counts, settings, noWriter) {
  const name = LIVE_SWITCH[table];
  const live = ALWAYS_LIVE.includes(table) || (name !== undefined && switchOn(name, settings));
  if (live) return 'live';
  if (counts) return 'shadow';
  return noWriter.includes(table) && name === undefined ? 'map' : 'none';
}

/**
 * The report for every move table, from the board's recorded counts and the machine settings.
 *
 * @param {Record<string, any>} shadows - Recorded counts by table.
 * @param {string[]} tables - Every table name found in the moves cell.
 * @param {object} settings - The machine settings.
 * @param {string[]} [noWriter] - Tables with no writer by design; a table that also has a switch is not one.
 */
export function movesReport(shadows, tables, settings, noWriter = NO_WRITER) {
  return [...new Set([...tables, ...Object.keys(shadows)])].sort().map(table => {
    const counts = shadows[table] ?? null;
    return { table, state: stateOf(table, counts, settings, noWriter), liveSwitch: LIVE_SWITCH[table] ?? null, compared: counts?.compared ?? 0, disagreed: counts?.disagreed ?? 0,
      firstCompareAt: counts?.since ?? null, lastDisagreedAt: counts?.lastDisagreedAt ?? null, lastDisagreements: counts?.last ?? [] };
  });
}

/** Run `pullboard moves` and return its exit code; it never writes the board. */
export function run(io) {
  const ctx = context(io);
  const shadows = withBoardRead(ctx, board => readShadows(board));
  const tables = movesReport(shadows, listMoveTables().map(tableName), loadMachineSettings());
  io.result?.({ tables });
  io.say('table      state   compared  disagreed  first compare');
  for (const row of tables) {
    io.say(`${row.table.padEnd(10)} ${row.state.padEnd(7)} ${String(row.compared).padStart(8)}  ${String(row.disagreed).padStart(9)}  ${row.firstCompareAt ?? 'never'}`);
    for (const miss of row.lastDisagreements.slice(-5)) io.say(`  disagreed on #${miss.id} at ${miss.at}: ${miss.differs}`);
  }
  return 0;
}
