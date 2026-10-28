/**
 * Submit preflight (#924): the board's own submit guards, run before any check or test. A refusal that no test
 * result can change (HEAD_NOT_NEW, NOT_YOURS, a pending refreeze, open children) used to come back only after the
 * whole proof ran; on 19 Oct #890 spent 679 s before HEAD_NOT_NEW. Here the real submit move runs in a transaction
 * that always rolls back, with a stand-in proof, so every board guard decides now and nothing is recorded.
 */
import { tryGit } from './git.js';
import { inPlanScope } from './cells-plan.js';
import { Refused } from './refused.js';

/** Bind placement to committed source, never an unstaged plan or the process working directory. */
export function requirePlannedSource(root, base, commit) {
  const index = 'bin/cells-plan.json';
  if (tryGit(root, ['cat-file', '-e', `${base}:${index}`]).status !== 0) return;
  /** Read only regular committed JSON blobs from the exact candidate. */
  const read = file => {
    const mode = tryGit(root, ['ls-tree', '-z', commit, '--', file]);
    const source = tryGit(root, ['show', `${commit}:${file}`]);
    if (mode.status !== 0 || !/^100(?:644|755) blob /u.test(mode.stdout) || source.status !== 0) {
      throw new Refused('CELLS_PLAN_UNPLACED', `restore the committed cells plan: ${file}`);
    }
    try { return JSON.parse(source.stdout); }
    catch { throw new Refused('CELLS_PLAN_UNPLACED', `restore valid committed cells plan JSON: ${file}`); }
  };
  const plan = read(index);
  if (!Array.isArray(plan.cells) || !Array.isArray(plan.stays)) throw new Refused('CELLS_PLAN_UNPLACED', 'restore the committed cells plan cells and stays');
  const known = new Set();
  for (const cell of plan.cells) {
    if (typeof cell.file !== 'string' || !/^bin\/cells-plan\/\d{2}-[a-z-]+\.json$/u.test(cell.file)) {
      throw new Refused('CELLS_PLAN_UNPLACED', 'restore the committed cell shard references');
    }
    const shard = read(cell.file);
    if (shard.name !== cell.name || !Array.isArray(shard.paths)) throw new Refused('CELLS_PLAN_UNPLACED', `restore the committed cell shard: ${cell.file}`);
    for (const row of shard.paths) {
      if (!Array.isArray(row) || row.length !== 3 || row.some(value => typeof value !== 'string') || !['seed', 'rule', 'imports'].includes(row[2])) {
        throw new Refused('CELLS_PLAN_UNPLACED', `restore the committed path rows: ${cell.file}`);
      }
      known.add(row[0]); known.add(row[1]);
    }
  }
  for (const stay of plan.stays) {
    if (typeof stay.path !== 'string' || typeof stay.reason !== 'string' || !stay.reason.trim()) throw new Refused('CELLS_PLAN_UNPLACED', 'restore the committed stay rows');
    known.add(stay.path);
  }
  const tracked = tryGit(root, ['ls-tree', '-r', '-z', commit]);
  if (tracked.status !== 0) throw new Refused('CELLS_PLAN_UNPLACED', 'the committed source paths could not be read from Git');
  const missing = [];
  for (const row of tracked.stdout.split('\0').filter(Boolean)) {
    const tab = row.indexOf('\t');
    const file = row.slice(tab + 1);
    if (tab < 0) throw new Refused('CELLS_PLAN_UNPLACED', 'the committed source inventory is malformed');
    if (!inPlanScope(file)) continue;
    if (!/^100(?:644|755) blob /u.test(row)) throw new Refused('CELLS_PLAN_UNPLACED', `restore a regular committed source path before placement: ${file}`);
    if (!known.has(file)) missing.push(file);
  }
  if (missing.length) throw new Refused('CELLS_PLAN_UNPLACED', `source paths have no cells-plan entry: ${missing.join(', ')}; place each with node bin/cells-plan.js --place <path> --cell <cell> (or --stay), then commit the source and plan`);
}

/** Thrown to roll back a preflight that passed; never escapes this module. */
const PASSED = Symbol('submit preflight passed');

/** A deferred proof that names no files: enough for the move's shape, never recorded. */
const STAND_IN_PROOF = Object.freeze({ version: 1, files: [], full: false, deferred: true, reason: 'submit preflight; no proof has run yet' });

/**
 * Refuse now, exactly as the submit itself would, when a board guard that needs no test result refuses.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, commit: string, tree: string }} submission
 */
export function submitPreflight(board, id, { agentId, commit, tree }, { atomic, submit }, review = {}) {
  try {
    atomic(board, () => {
      submit(board, id, { agentId, commit, tree, files: [], submissionProof: STAND_IN_PROOF });
      // The item is submitted only inside this rolled-back transaction, which is what the native eligibility projection reads.
      review.refuse?.(board, board.db.prepare('SELECT * FROM item WHERE item_id=?').get(id));
      throw PASSED;
    });
  } catch (error) {
    if (error !== PASSED) throw error;
  }
}
