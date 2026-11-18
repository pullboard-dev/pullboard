/** @pullboard-module-loads packages/moves/src/logic/table/*.table.js */
/** Load a move table by name and report on it: how often it agrees with the board, and what it says in order [C7,#8071,#8072]. */
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Refused } from '../../../../kernel/light.js';
import { judgeByReleaseEnabled } from '../../../../config/index.js';
import { tryGit } from '../../../../git/index.js';
import { explainTable } from '../../logic/table/explain.js';
import { judgeRecords } from '../../logic/table/judge.js';
import { judgeSummary } from '../../logic/table/judge.js';
import { recordedOutcome } from '../../logic/table/replay.js';
import { replayTable } from '../../logic/table/replay.js';
import { runTable } from '../../logic/table/run.js';
import { loadDiscovered } from '../registry.js';
import { loadMoveTableAtTag } from './at-tag.js';
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

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * What a table answers for each replayable record, by event id, in the shape the judge compares: a refusal by its code, or an acceptance with its events.
 * A record is replayable on the same terms replayTable uses: a readable event, at or after the cut, with a snapshot, a move and a recorded decision.
 * A record the rules cannot read gets no answer, so it matches nothing.
 */
function answersOf(table, rules, records) {
  const answers = new Map();
  for (const record of records) {
    try {
      const answer = runTable(table, rules, structuredClone(record.snapshot), structuredClone(record.move));
      answers.set(record.event.id, answer.refused ? { decision: 'refused', code: answer.refused.code } : { decision: 'accepted', events: JSON.parse(JSON.stringify(answer.events)) });
    } catch { /* no answer: it matches nothing */ }
  }
  return answers;
}

/** The records replayTable would replay: readable, at or after the cut, and carrying a snapshot, a move and a recorded decision. */
function replayable(records, cutAt) {
  return records.filter((record) => {
    const at = typeof record?.event?.at === 'number' ? record.event.at : Date.parse(record?.event?.at);
    return isObject(record) && record.event?.id !== undefined && Number.isFinite(at) && at >= cutAt
      && isObject(record.snapshot) && isObject(record.move) && recordedOutcome(record.recorded) !== null;
  });
}

/**
 * Judge each replayable record by the released table, at a tag, and the current table, against what the board wrote.
 * Why: a table change must not grade itself; the release's own tables are the second opinion. Read-only, and off unless moves.judgeByRelease is on.
 *
 * @returns {Promise<{ against: string, counts: object, rows: object[] }>} Counts for every record; rows only for the records where the two tables differ from each other or from the board.
 */
async function judgeAgainst(root, name, against, loaded, records, cutAt) {
  const released = await loadMoveTableAtTag(root, name, against);
  try {
    const kept = replayable(records, cutAt);
    const judged = judgeRecords(kept, answersOf(released.table, released.rules, kept), answersOf(loaded.table, loaded.rules, kept));
    return { against: released.tag, counts: judged.counts, rows: judged.rows.filter((row) => row.class !== 'same') };
  } finally { released.dispose(); }
}

/**
 * Replay a table over the moves the board recorded in the last `days` days.
 * Why: a table is trusted only once it reproduces what the board decided; the board holds accepted moves only, so this checks accepted moves.
 * With `against` set (a release tag) and moves.judgeByRelease on, the report also carries `judge`: the tag's table and the current table over the same records, one row per record they do not both get right [U150].
 *
 * @param {{ root: string, boardFile: string, name: string, days?: number, now?: number, cut?: string, against?: string }} options
 * @returns {Promise<{ table: string, days: number, since: string, cut: string, total: number, agreed: number, disagreed: number, notReplayable: number, beforeCut: number, disagreements: object[], unreplayable: object[], judge?: { against: string, counts: object, rows: object[] } }>}
 */
export async function replayReport({ root, boardFile, name, days = 7, now = Date.now(), cut, against }) {
  if (!Number.isFinite(days) || days <= 0) throw new Refused('REPLAY_DAYS', 'replay looks back a number of days, and got none', 'pass --days 7');
  if (against !== undefined && !judgeByReleaseEnabled()) {
    throw new Refused('JUDGE_OFF', 'judging by a release is off on this machine', 'turn on the machine setting moves.judgeByRelease, or replay without a release tag');
  }
  const loaded = await loadMoveTable(root, name, 'REPLAY_TABLE');
  const since = new Date(now - days * DAY_MS).toISOString();
  const cutAt = cut ?? tagCut(root) ?? since;
  const records = readMoveRecords(boardFile, { since });
  const report = replayTable(loaded.table, loaded.rules, records, { cut: cutAt });
  const out = { table: name, days, since, cut: new Date(Date.parse(cutAt)).toISOString(), ...report };
  if (against === undefined) return out;
  return { ...out, judge: await judgeAgainst(root, name, against, loaded, records, Date.parse(cutAt)) };
}

/**
 * Judge every current move table against one release and fold the answers into a verdict [U150].
 * A table the release did not have is listed as new, never refused; any other refusal propagates. Read-only, and off unless moves.judgeByRelease is on.
 * Why: a release has about 15 tables, and the question is whether any of them drifted from the last release.
 *
 * @param {{ root: string, boardFile: string, against: string, days?: number, now?: number, cut?: string }} options - `against` is a release tag, or `last`.
 * @returns {Promise<{ against: string, days: number, since: string, rows: object[], newTables: string[], drifted: string[], clean: boolean }>}
 */
export async function judgeAllReport({ root, boardFile, against, days = 7, now = Date.now(), cut }) {
  if (!Number.isFinite(days) || days <= 0) throw new Refused('REPLAY_DAYS', 'replay looks back a number of days, and got none', 'pass --days 7');
  if (!judgeByReleaseEnabled()) {
    throw new Refused('JUDGE_OFF', 'judging by a release is off on this machine', 'turn on the machine setting moves.judgeByRelease, or replay without a release tag');
  }
  const since = new Date(now - days * DAY_MS).toISOString();
  const cutAt = Date.parse(cut ?? tagCut(root) ?? since);
  const records = readMoveRecords(boardFile, { since });
  const tables = [];
  for (const path of listMoveTables(root)) {
    const name = nameOf(path);
    const loaded = await loadMoveTable(root, name, 'REPLAY_TABLE');
    try { tables.push({ table: name, judge: await judgeAgainst(root, name, against, loaded, records, cutAt) }); }
    catch (error) {
      if (!((error?.code === 'JUDGE_TABLE' && /holds no move table/u.test(error.message)) || (error?.code === 'JUDGE_TAG' && /no release tag holds move table/u.test(error.message)))) throw error;
      tables.push({ table: name, missing: true });
    }
  }
  const resolved = tables.find((entry) => entry.judge)?.judge.against ?? against;
  return { against: resolved, days, since, ...judgeSummary(tables) };
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

/** The U152 backbone reader, loaded at the call so the hot commands that load the moves door load no new module [C7,#10580]. This door file keeps index.js a pure export front, which the source walk needs to reach the freezer [#10650]. */
export async function readBackboneRecords(...args) { return (await import('./backbone-records.js')).readBackboneRecords(...args); }
/** The backbone summary, loaded at the call like its reader. */
export async function backboneSummary(...args) { return (await import('./backbone-records.js')).backboneSummary(...args); }
