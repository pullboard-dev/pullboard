/** The submit gate's move-table replay: a submit that changes a move table must still agree with what the board recorded [C7,#8073]. */
import { fileSystemAdapter } from '../../../../fs/index.js';
import { basename } from 'node:path';
import { Refused } from '../../../../kernel/index.js';

const fs = fileSystemAdapter();

/** A move table's file name ends in `.table.js`. */
const TABLE_FILE = /\.table\.js$/u;
/** The most disagreeing events a refusal names, so a new rule's blast radius reads as one line. */
const NAMED_EVENTS = 12;

/**
 * Name the move tables a diff changes.
 * Why: only a changed table can start disagreeing with the board, so an unchanged table costs the gate nothing.
 *
 * @param {string[]} changed - Repo-relative changed paths.
 * @returns {string[]} Table names, sorted, each once.
 */
export function changedTables(changed) {
  const names = (changed ?? []).filter(path => TABLE_FILE.test(path)).map(path => basename(path).replace(TABLE_FILE, ''));
  return [...new Set(names)].sort();
}

/**
 * Replay every changed move table over the board's recorded moves and refuse on any disagreement.
 * The board is read-only here; with no board file (a fresh clone) there is nothing recorded to disagree with.
 *
 * @param {string} root - The tree the gate runs on, whose files hold the changed tables.
 * @param {{ changed?: string[], boardFile?: string, days?: number, replay: (options: { root: string, boardFile: string, name: string, days: number }) => Promise<{ total: number, agreed: number, disagreed: number, disagreements: { event: number | string }[] }> }} options - `replay` is the moves cell's report, handed in so the gate never imports that cell.
 * @returns {Promise<{ table: string, total: number, agreed: number, disagreed: number }[]>} One row per replayed table.
 */
export async function replayChangedTables(root, { changed, boardFile, days = 7, replay }) {
  const names = changedTables(changed);
  if (!names.length) return [];
  if (!boardFile || !fs.exists(boardFile)) return [];
  const rows = [];
  const bad = [];
  for (const name of names) {
    const report = await replay({ root, boardFile, name, days });
    rows.push({ table: name, total: report.total, agreed: report.agreed, disagreed: report.disagreed });
    if (report.disagreed > 0) bad.push({ name, events: report.disagreements.map(row => row.event) });
  }
  if (bad.length) {
    const say = ({ name, events }) => `${name} disagrees with the board on ${events.length} recorded move${events.length === 1 ? '' : 's'} (event ${events.slice(0, NAMED_EVENTS).join(', ')}${events.length > NAMED_EVENTS ? `, and ${events.length - NAMED_EVENTS} more` : ''})`;
    throw new Refused('TABLE_REPLAY', bad.map(say).join('; '), `run pullboard replay ${bad[0].name} to see each difference, then fix the rule or ask the person to rule on it`);
  }
  return rows;
}
