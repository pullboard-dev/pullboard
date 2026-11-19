/** The pullboard moves command: each move table's recorded shadow compares, disagreements and state, read-only [C7,#8378]. */
import { loadMachineSettings } from '../../../../../packages/config/index.js';
import { MACHINE_DEFAULTS } from '../../../../../packages/config/index.js';
import { backboneSummary } from '../../../../../packages/moves/index.js';
import { listMoveTables } from '../../../../../packages/moves/index.js';
import { readBackboneRecords } from '../../../../../packages/moves/index.js';
import { readShadows } from '../../../../../packages/store/index.js';
import { windowReport } from '../../logic/moves-window.js';
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
export const LIVE_SWITCH = Object.freeze({
  claim: 'moves.live.claim', commit: 'moves.live.submit', submit: 'moves.live.submit', start: 'moves.live.handoff', complete: 'moves.live.handoff',
  outcome: 'moves.live.outcome', job: 'moves.live.job', reopen: 'moves.live.reopen', reclaim: 'moves.live.reclaim', outbox: 'moves.live.outbox', hop: 'gate.fencedHop',
});

/** Whether a switch is on: a moves.live switch as set, else its machine default; gate.fencedHop unless set false, its default being on [C7,#8327,#8395]. */
function switchOn(name, settings) {
  if (name === 'gate.fencedHop') return settings.gate?.fencedHop !== false;
  return (settings.moves?.live?.[name.slice('moves.live.'.length)] ?? MACHINE_DEFAULTS[name]) === true;
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
 * @param {Date} [now] - The time the clean window is measured to.
 * @param {{ compared: number, unserved: number, unreadable: Record<string, number>, last: object[] } | null} [backbone] - The backbone's read of the live jobs: compared is served plus unserved; unreadable counts by job kind [C7,#10584].
 */
export function movesReport(shadows, tables, settings, noWriter = NO_WRITER, now = new Date(), backbone = null) {
  return [...new Set([...tables, ...Object.keys(shadows)])].sort().map(table => {
    // The backbone has no writer to record compares, so its compares are the jobs just read: shadow once one was compared, else map [C7,#10584].
    const counts = shadows[table] ?? (table === 'backbone' && backbone?.compared > 0 ? { compared: backbone.compared, disagreed: backbone.unserved, since: null, lastDisagreedAt: null, last: backbone.last } : null);
    const base = { table, state: stateOf(table, counts, settings, noWriter), liveSwitch: LIVE_SWITCH[table] ?? null, compared: counts?.compared ?? 0, disagreed: counts?.disagreed ?? 0,
      firstCompareAt: counts?.since ?? null, lastDisagreedAt: counts?.lastDisagreedAt ?? null, lastDisagreements: counts?.last ?? [],
      windowCompared: Number.isSafeInteger(counts?.windowCompared) ? counts.windowCompared : null, ...(table === 'backbone' && backbone ? { unreadable: backbone.unreadable } : {}) };
    return { ...base, ...windowReport(base, now) };
  });
}

/**
 * The table names the report lists: every `*.table.js` in the moves cell plus every table a live switch governs.
 * Why the switches too: the hand-off writer records start and complete, which have no table file of their own, so with
 * submit.handoff off they would never appear; a shadowed writer with no compares must still show, at 0 [C7,#10493].
 *
 * @param {string[]} paths - The move table file paths.
 */
export function moveTableNames(paths) {
  return [...new Set([...paths.map(tableName), ...Object.keys(LIVE_SWITCH)])];
}

/** The window the backbone reads live jobs over: those offered in the last 24 hours [C7,#10584]. */
const BACKBONE_WINDOW_MS = 24 * 3_600_000;

/** The backbone's read of the live jobs offered in the window, as movesReport takes it; the board is only read [C7,#10584]. */
async function readBackbone(file, now) {
  const { records } = await readBackboneRecords(file, { since: new Date(now.getTime() - BACKBONE_WINDOW_MS).toISOString() });
  const summary = await backboneSummary(records);
  const unreadable = Object.fromEntries(Object.entries(summary.byKind).filter(([, counts]) => counts.unreadable > 0).map(([kind, counts]) => [kind, counts.unreadable]));
  const last = records.filter(record => record.outcome === 'unserved').map(record => ({ id: record.item, at: now.toISOString(), differs: `${record.job} (${record.failing.join(', ')})` }));
  return { compared: summary.compared, unserved: summary.unserved, unreadable, last };
}

/** Run `pullboard moves` and return its exit code; it never writes the board. */
export async function run(io) {
  const ctx = context(io);
  const shadows = withBoardRead(ctx, board => readShadows(board));
  const now = new Date();
  const tables = movesReport(shadows, moveTableNames(listMoveTables()), loadMachineSettings(), NO_WRITER, now, await readBackbone(ctx.file, now));
  io.result?.({ tables });
  io.say('table      state   compared  disagreed  first compare             clean window');
  for (const row of tables) {
    io.say(`${row.table.padEnd(10)} ${row.state.padEnd(7)} ${String(row.compared).padStart(8)}  ${String(row.disagreed).padStart(9)}  ${(row.firstCompareAt ?? 'never').padEnd(24)}  ${row.ready ? 'ready' : row.windowStart ? `${row.windowHours.toFixed(1)} h` : 'none'}`);
    for (const miss of row.lastDisagreements.slice(-5)) io.say(`  disagreed on #${miss.id} at ${miss.at}: ${miss.differs}`);
  }
  return 0;
}
