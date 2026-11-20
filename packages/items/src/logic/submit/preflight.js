/**
 * Submit preflight (#924): the board's own submit guards, run before any check or test. A refusal that no test
 * result can change (HEAD_NOT_NEW, NOT_YOURS, a pending refreeze, open children) used to come back only after the
 * whole proof ran; on 19 Oct #890 spent 679 s before HEAD_NOT_NEW. Here the real submit move runs in a transaction
 * that always rolls back, with a stand-in proof, so every board guard decides now and nothing is recorded.
 */
import { tryGit } from "../../../../git/index.js";
import { Refused } from "../../../../kernel/index.js";
import { environmentAdapter } from "../../../../env/index.js";

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
  const env = Object.fromEntries(Object.entries(environmentAdapter().all()).filter(([key]) => !OBJECT_ENV.test(key)));
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

/**
 * Fetch each named commit a job checkout lacks from the trunk remote, by id first, then by the remote's branches, and
 * return the ones still missing. Why: a job checkout holds only main and the candidate, while an item claimed on another
 * item's commit has its claim base only on that item's branch, so its lane policy was unreadable there (#5808). It lives
 * beside readTrunkEntry so a runner job fetches a missing trunk commit in one place [C7].
 *
 * @param {string} root The job checkout.
 * @param {string[]} commits Commit ids the read needs.
 * @param {string} remote The job's trunk remote; none, or one that looks like an option, fetches nothing.
 * @returns {string[]} The commits still absent after fetching.
 */
export function fetchMissingCommits(root, commits, remote) {
  const env = { ...Object.fromEntries(Object.entries(environmentAdapter().all()).filter(([key]) => !key.startsWith('GIT_'))), GIT_TERMINAL_PROMPT: '0' };
  const quiet = ['-q', '--no-tags', '--no-write-fetch-head', '--', remote];
  const absent = list => list.filter(commit => tryGit(root, ['cat-file', '-e', `${commit}^{commit}`], { env }).status !== 0);
  let missing = absent(commits);
  if (!missing.length || !remote || remote.startsWith('-')) return missing;
  for (const commit of missing) tryGit(root, ['-c', 'protocol.version=2', 'fetch', ...quiet, commit], { env });
  missing = absent(missing);
  if (missing.length) tryGit(root, ['fetch', ...quiet, '+refs/heads/*:refs/pullboard/trunk-heads/*'], { env });
  return absent(missing);
}

/** Where a missing trunk commit can be fetched from: the recorded job source first, then each named remote. */
function trunkSources(root, env) {
  const recorded = tryGit(root, ['config', '--get', 'pullboard.fetchSource'], { env });
  const remotes = tryGit(root, ['remote'], { env });
  return [...new Set([...(recorded.status === 0 && recorded.stdout ? [recorded.stdout] : []),
    ...(remotes.status === 0 ? remotes.stdout.split('\n').filter(Boolean) : [])])];
}

/**
 * Deprecated no-op (#6365): plan placement is dropped, so this never refuses. It stays exported only so its importers
 * keep loading; #6368 and #6369 remove the callers and #6370 deletes it.
 * @returns {undefined}
 */
export function requirePlannedSource() {}

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
