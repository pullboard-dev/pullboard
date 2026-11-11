/**
 * Submit preflight (#924): the board's own submit guards, run before any check or test. A refusal that no test
 * result can change (HEAD_NOT_NEW, NOT_YOURS, a pending refreeze, open children) used to come back only after the
 * whole proof ran; on 19 Oct #890 spent 679 s before HEAD_NOT_NEW. Here the real submit move runs in a transaction
 * that always rolls back, with a stand-in proof, so every board guard decides now and nothing is recorded.
 */
import { tryGit } from "../../../../git/index.js";
import { inPlanScope } from "../../../../codemap/index.js";
import { moveHistoryPlacement } from "../../../../codemap/index.js";
import { Refused } from "../../../../kernel/index.js";

/** Git variables that could narrow which objects a read sees; trunk reads run without them. */
const OBJECT_ENV = /^GIT_(?:DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|WORK_TREE|INDEX_FILE)$/u;

/**
 * Read one trunk tree entry. Main lands while a job runs, so the trunk commit can be missing from the checkout that
 * reads it: a failed read is retried through the repository's common Git dir, then the commit is fetched from the
 * checkout's recorded source (a runner job checkout has no remote; it records pullboard.fetchSource) and every remote,
 * and read again, once more after a second fetch. A read that still fails is an infrastructure error (not a Refused),
 * so the gate retries it and the builder never sees 'not a tree object' (#2521, #2534).
 *
 * @param {string} root
 * @param {string} base
 * @param {string} file
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
export function readTrunkEntry(root, base, file) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !OBJECT_ENV.test(key)));
  const args = ['ls-tree', '-z', base, '--', file];
  let result = tryGit(root, args, { env });
  if (result.status === 0) return result;
  const common = tryGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { env });
  if (common.status === 0 && common.stdout) {
    result = tryGit(root, ['--git-dir', common.stdout, ...args], { env });
    if (result.status === 0) return result;
  }
  const sources = trunkSources(root, env);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const fetched = sources.map(source => tryGit(root, ['-c', 'protocol.version=2', '-c', 'protocol.file.allow=always', 'fetch', '--quiet', '--no-tags', source, base], { env }));
    result = tryGit(root, args, { env });
    if (result.status === 0) return result;
    if (!fetched.length) break;
    const failed = fetched.find(row => row.status !== 0);
    if (failed?.stderr) result = { ...result, stderr: `${result.stderr}\nfetch: ${failed.stderr}` };
  }
  throw Object.assign(new Error(`the accepted cells-plan presence could not be read from Git (infrastructure error, retry the submit: ${result.stderr.split('\n')[0] || 'trunk object missing'}; fetched from ${sources.length ? sources.join(', ') : 'no recorded source'})`),
    { name: 'GitReadInfrastructureError', code: 'GIT_READ_INFRASTRUCTURE', retryable: true });
}

/** Where a missing trunk commit can be fetched from: the recorded job source first, then each named remote. */
function trunkSources(root, env) {
  const recorded = tryGit(root, ['config', '--get', 'pullboard.fetchSource'], { env });
  const remotes = tryGit(root, ['remote'], { env });
  return [...new Set([...(recorded.status === 0 && recorded.stdout ? [recorded.stdout] : []),
    ...(remotes.status === 0 ? remotes.stdout.split('\n').filter(Boolean) : [])])];
}

/**
 * Bind placement to committed source, never an unstaged plan or the process working directory. With deferUnplaced
 * a missing placement returns to the cells check, which refuses it only on Cells reorg work (#2473).
 */
export function requirePlannedSource(root, base, commit, { deferUnplaced = false } = {}) {
  const index = 'packages/codemap/data/plan/cells.json';
  const accepted = readTrunkEntry(root, base, index);
  if (!accepted.stdout) return;
  if (!/^100(?:644|755) blob /u.test(accepted.stdout)) throw new Refused('CELLS_PLAN_UNPLACED', 'restore a regular cells-plan index on accepted main');
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
    if (typeof cell.file !== 'string' || !/^packages\/codemap\/data\/plan\/\d{2}-[a-z-]+\.json$/u.test(cell.file)) {
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
    if (!known.has(file) && moveHistoryPlacement(file) === null) missing.push(file);
  }
  if (missing.length && deferUnplaced) return { unplaced: missing };
  if (missing.length) throw new Refused('CELLS_PLAN_UNPLACED', `source paths have no cells-plan entry: ${missing.join(', ')}; place each with node packages/codemap/src/io/cells/scripts/plan.js --place <path> --cell <cell> (or --stay), then commit the source and plan`);
}

/** Thrown to roll back a preflight that passed; never escapes this module. */
const PASSED = Symbol('submit preflight passed');

/**
 * A deferred proof that names only the test files the gate will run: enough for the move's shape, never recorded. Why: a
 * [test] clause the gate ticks from a file the bar names was refused CLAUSE_UNTICKED here, before the gate could run it
 * (#3665) [C7,V4].
 */
function standInProof(gateFiles = []) {
  return Object.freeze({ version: 1, files: [...gateFiles].sort(), full: false, deferred: true, reason: 'submit preflight; no proof has run yet' });
}

/**
 * Refuse now, exactly as the submit itself would, when a board guard that needs no test result refuses.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, commit: string, tree: string, gateFiles?: Iterable<string> }} submission - gateFiles are the
 *   test files the submit's gate will run, which tick the [test] clauses that name them
 */
export function submitPreflight(board, id, { agentId, commit, tree, submissionSize, inspectClauses, gateFiles = [] }, { atomic, submit, prepareSubmit }, review = {}) {
  // Another seat's commit between preparation and the dry-run makes the prepared snapshot stale; prepare again from
  // the new board, bounded so a board that changes on every attempt still refuses BOARD_BUSY (#3100).
  for (let attempt = 1; ; attempt++) {
    const options = { agentId, commit, tree, files: [], ...(inspectClauses ? { inspectClauses: true } : {}), submissionProof: standInProof(gateFiles), ...(submissionSize ? { submissionSize } : {}) };
    try {
      const prepared = prepareSubmit ? prepareSubmit(board, id, options) : options;
      atomic(board, () => {
        submit(board, id, prepared);
        // The item is submitted only inside this rolled-back transaction, which is what the native eligibility projection reads.
        review.refuse?.(board, board.db.prepare('SELECT * FROM item WHERE item_id=?').get(id));
        throw PASSED;
      });
    } catch (error) {
      if (error === PASSED) return;
      if (!staleSnapshot(error) || attempt >= PREFLIGHT_ATTEMPTS) throw error;
    }
  }
}

/** Dry-run preparations before a still-changing board is reported BOARD_BUSY. */
const PREFLIGHT_ATTEMPTS = 6;

/** Only a stale prepared snapshot is retried; a held write lock or any other refusal is reported as it stands. */
function staleSnapshot(error) {
  return error instanceof Refused && error.code === 'BOARD_BUSY' && /the board changed while preparing/u.test(String(error.message));
}
