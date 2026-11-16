/** @pullboard-module-loads packages/moves/src/logic/table/*.table.js */
/** Load a move table by name and report on it: how often it agrees with the board, and what it says in order [C7,#8071,#8072]. */
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Refused } from '../../../../kernel/light.js';
import { tryGit } from '../../../../git/index.js';
import { explainTable } from '../../logic/table/explain.js';
import { replayTable } from '../../logic/table/replay.js';
import { loadDiscovered } from '../registry.js';
import { listMoveTables } from './read.js';
import { readMoveRecords } from './read.js';

/** The release whose tag time is the replay cut: records before it have snapshots the tables never read. */
const CUT_TAG = 'v0.9.4';
const DAY_MS = 86_400_000;

/** A table's name is its file's name without `.table.js`. */
const nameOf = (path) => basename(path).replace(/\.table\.js$/u, '');

/**
 * Find a table by name, import it, and return it with its rules.
 * A table module exports one `*_TABLE` and one `*_RULES`; a module with a different shape is known but cannot be reported on.
 * Why: a name is found by where the table lives, so a new table needs no edit to any list (RFC 0006 CD30).
 *
 * @param {string} root - The repository root.
 * @param {string | undefined} name
 * @param {'REPLAY_TABLE' | 'EXPLAIN_TABLE'} code - The refusal code the command owns.
 * @returns {Promise<{ name: string, file: string, table: object, rules: object }>}
 */
export async function loadMoveTable(root, name, code) {
  const files = listMoveTables(root);
  const known = files.map(nameOf);
  const verb = code === 'REPLAY_TABLE' ? 'replay' : 'explain';
  const file = files.find(path => nameOf(path) === name);
  if (!file) {
    throw new Refused(code, `${name ? `no move table is called ${name}` : `${verb} needs the name of a move table`}; the known tables are ${known.join(', ') || 'none'}`,
      `run pullboard ${verb} <table> with one of: ${known.join(', ') || '(none found)'}`);
  }
  const module = loadDiscovered(file, pathToFileURL(root.endsWith('/') ? root : `${root}/`));
  const pick = (suffix) => Object.entries(module).find(([key]) => key.endsWith(suffix))?.[1];
  const table = pick('_TABLE');
  const rules = pick('_RULES');
  if (!table || !rules) {
    throw new Refused(code, `table ${name} is not a table ${verb} can read, since ${file} exports no *_TABLE and *_RULES pair`, `run pullboard ${verb} with one of: ${known.join(', ')}`);
  }
  return { name, file, table, rules };
}

/** The v0.9.4 cut as an ISO time: the tag's commit time, or null when this repository has no such tag. */
function tagCut(root) {
  const read = tryGit(root, ['log', '-1', '--format=%cI', CUT_TAG]);
  return read.status === 0 && read.stdout ? new Date(read.stdout).toISOString() : null;
}

/**
 * Replay a table over the moves the board recorded in the last `days` days.
 * Why: a table is trusted only once it reproduces what the board decided; the board holds accepted moves only, so this checks accepted moves.
 *
 * @param {{ root: string, boardFile: string, name: string, days?: number, now?: number, cut?: string }} options
 * @returns {Promise<{ table: string, days: number, since: string, cut: string, total: number, agreed: number, disagreed: number, notReplayable: number, beforeCut: number, disagreements: object[], unreplayable: object[] }>}
 */
export async function replayReport({ root, boardFile, name, days = 7, now = Date.now(), cut }) {
  if (!Number.isFinite(days) || days <= 0) throw new Refused('REPLAY_DAYS', 'replay looks back a number of days, and got none', 'pass --days 7');
  const loaded = await loadMoveTable(root, name, 'REPLAY_TABLE');
  const since = new Date(now - days * DAY_MS).toISOString();
  const cutAt = cut ?? tagCut(root) ?? since;
  const records = readMoveRecords(boardFile, { since });
  const report = replayTable(loaded.table, loaded.rules, records, { cut: cutAt });
  return { table: name, days, since, cut: new Date(Date.parse(cutAt)).toISOString(), ...report };
}

/**
 * Explain a table: its guards in order with each code and next step, then its outcomes and follow-ups.
 * Why: an agent asks "what can happen from here" without reading the table's source; nothing is read from the board.
 *
 * @param {{ root: string, name: string }} options
 * @returns {Promise<{ table: string, guards: object[], outcomes: object[], followups: object[] }>}
 */
export async function explainReport({ root, name }) {
  const loaded = await loadMoveTable(root, name, 'EXPLAIN_TABLE');
  return explainTable(loaded.table, loaded.rules);
}
