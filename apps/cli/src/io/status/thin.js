/**
 * The thin read door for `pullboard status`, first slice of #10761: the seats of a plain board, read through the light
 * store alone, never the board barrel. Status prints landing, relay, runner, health, job and verify-proof sections that
 * need readers this door does not have, so a board holding any record of those kinds, and any board a read must not
 * open, steps aside for the full path. Status always falls through to the full path for now, so its output cannot change [C7,#10761].
 */
import * as store from '../../../../../packages/store/light.js';
import { repoInfo } from '../../../../../packages/git/light.js';
import { derivedStateEnabled } from '../../../../../packages/config/light.js';

/** The event kinds that make the full status print a section this door cannot serve. */
const SECTION_KINDS = ['land_%', 'relay%', 'runner%', 'health%', 'verify%'];
/** The tables whose rows make the full status read a job, runner run or verify proof. */
const SECTION_TABLES = ['job', 'run', 'test_result'];

/** Whether the board holds any record that makes the full status print a section this door cannot. */
function hasSectionRecords(db) {
  const made = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
  if (SECTION_TABLES.some(table => made.has(table) && db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())) return true;
  const clause = [...SECTION_KINDS.map(() => 'event_kind LIKE ?'), "(event_kind LIKE 'landing%' AND event_kind <> 'landing_batch')"].join(' OR ');
  return Boolean(db.prepare(`SELECT 1 FROM event WHERE ${clause} LIMIT 1`).get(...SECTION_KINDS));
}

/**
 * The facts `pullboard status` would print for a plain board, or null when the full path must run it: no readable
 * board, a drifted board, a read that needs a write, or any unsupported landing, relay, runner, health, job or verify-proof record.
 *
 * @param {{ cwd: string, clock?: any, open?: Function }} request
 * @returns {Promise<{ agents: any[] } | null>}
 */
export async function thinStatusFacts({ cwd, clock = store.systemClock, open = store.openBoardForRead }) {
  if (derivedStateEnabled()) return null;
  const info = repoInfo(cwd);
  const board = open(`${info.commonDir}/pullboard/board.sqlite`, clock);
  if (!board) return null;
  if (!board.current || board.drifted) { store.closeBoard(board); return null; }
  try {
    if (hasSectionRecords(board.db)) return null;
    const items = store.listItems(board, { all: true });
    const lanes = [...new Set(items.map(item => item.item_lane))].sort();
    return { agents: store.listAgents(board), lanes };
  } catch (error) {
    if (error instanceof store.ReadNeedsWrite || store.writeRefused(error) || store.schemaMissing(error)) return null;
    throw error;
  } finally { store.closeBoard(board); }
}
