/** Best-effort local pruning follows an ordered retirement receipt, never changes the board [R3,C7]. */
import { spawnSync } from './windows-child-process.js';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { cleanGitEnvironment } from './git.js';

const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu;

/** A failed or incomplete Git observation never supplies a cleanup permission. */
function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, env: cleanGitEnvironment(), encoding: 'utf8',
    timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
  return result.status === 0 && !result.error && !result.signal ? result.stdout : null;
}

/** Compare path components, not textual prefixes such as tree and tree-old. */
function contains(parent, child) {
  const part = relative(parent, child);
  return part === '' || part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part);
}

/** Read Git's NUL-delimited registration without interpreting quoted path spellings. */
function registeredTrees(root) {
  const output = git(root, ['worktree', 'list', '--porcelain', '-z']);
  if (!output || !output.endsWith('\0')) return null;
  const trees = [];
  let entry = null;
  for (const field of output.split('\0')) {
    if (!field) continue;
    if (field.startsWith('worktree ')) {
      entry = { path: field.slice(9) };
      if (!isAbsolute(entry.path)) return null;
      trees.push(entry);
    } else if (!entry) return null;
    else if (field === 'bare') entry.bare = true;
    else if (field === 'locked' || field.startsWith('locked ')) entry.locked = true;
    else if (field.startsWith('HEAD ')) entry.head = field.slice(5);
  }
  return trees.length && trees.every(tree => tree.bare || COMMIT.test(tree.head ?? '')) ? trees : null;
}

/**
 * Parse lsof -Fpn0 cwd records. Incomplete, duplicate or unknown fields are not an idle machine.
 * The returned paths stay in memory; only matching target PIDs belong in a cleanup receipt.
 */
export function parseWorkingDirectoryCensus(output) {
  if (typeof output !== 'string' || !output || !/\0\n?$/u.test(output)) return null;
  const rows = [];
  const seen = new Set();
  let pid = null;
  let descriptor = false;
  let complete = false;
  for (const raw of output.split('\0')) {
    const field = raw.replace(/^\n/u, '');
    if (!field) continue;
    if (/^p[1-9][0-9]*$/u.test(field)) {
      if (pid !== null && !complete) return null;
      pid = Number(field.slice(1));
      if (!Number.isSafeInteger(pid) || seen.has(pid)) return null;
      seen.add(pid);
      descriptor = false;
      complete = false;
    } else if (field === 'fcwd' && pid !== null && !descriptor) descriptor = true;
    else if (field.startsWith('n') && descriptor && !complete && isAbsolute(field.slice(1))) {
      rows.push({ pid, path: field.slice(1) });
      complete = true;
    } else return null;
  }
  return complete && rows.length ? rows : null;
}

/** Observe supported native cwd metadata without trusting a caller's PATH replacement for lsof. */
function workingDirectories() {
  const executable = process.platform === 'darwin' ? '/usr/sbin/lsof'
    : process.platform === 'linux' ? '/usr/bin/lsof' : null;
  if (!executable || !existsSync(executable)) return null;
  const result = spawnSync(executable, ['-nP', '-a', '-d', 'cwd', '-Fpn0'], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error || result.signal || result.stderr.trim()) return null;
  return parseWorkingDirectoryCensus(result.stdout);
}

/** Verify the parent supplied a specific native retirement target and its landed item commits. */
function targetProblem(target, tip) {
  if (!target || typeof target !== 'object' || typeof target.agent !== 'string' || !target.agent
      || ['coordinator', 'person'].includes(target.agent) || typeof target.path !== 'string' || !isAbsolute(target.path)
      || typeof target.batch !== 'string' || !target.batch || typeof target.at !== 'string'
      || !Array.isArray(target.items) || !target.items.length
      || target.items.some(item => !Number.isSafeInteger(item?.item) || item.item < 1
        || !COMMIT.test(item.commit ?? '') || !COMMIT.test(item.merge ?? ''))) return 'invalid retirement target';
  if (!COMMIT.test(tip ?? '')) return 'invalid landed tip';
  return null;
}

/** Keep the parent's identity and item evidence, without copying arbitrary attached data. */
function receiptTarget(target) {
  return { agent: target?.agent ?? null, path: target?.path ?? null, batch: target?.batch ?? null,
    at: target?.at ?? null, items: Array.isArray(target?.items)
      ? target.items.map(item => ({ item: item?.item, commit: item?.commit, merge: item?.merge })) : [] };
}

/** Verify registration, common directory, exclusions, landed bytes and all local dirt afresh. */
function localProblem(root, common, target, tip, exclude) {
  const trees = registeredTrees(root);
  if (!trees) return 'worktree registration unavailable';
  const path = resolve(target.path);
  const entry = trees.find(tree => resolve(tree.path) === path);
  if (!entry || entry.bare) return 'not a registered linked worktree';
  if (resolve(trees[0].path) === path || resolve(root) === path) return 'primary or caller repository';
  if (entry.locked) return 'worktree is locked';
  try {
    if (lstatSync(path).isSymbolicLink() || realpathSync(path) !== path) return 'worktree path changed or is a symlink';
    if (contains(path, realpathSync(process.cwd()))) return 'caller working directory';
    for (const protectedPath of exclude) if (contains(path, realpathSync(protectedPath))) return 'excluded proof worktree';
    const actualCommon = git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const top = git(path, ['rev-parse', '--show-toplevel']);
    if (!actualCommon || !top || realpathSync(actualCommon.trim()) !== common || realpathSync(top.trim()) !== path) return 'different repository or worktree identity';
  } catch { return 'worktree or exclusion identity unavailable'; }
  const head = git(path, ['rev-parse', '--verify', 'HEAD']);
  if (!head || !COMMIT.test(head.trim()) || git(root, ['merge-base', '--is-ancestor', head.trim(), tip]) === null) return 'worktree HEAD is not landed';
  for (const item of target.items) {
    if (git(root, ['merge-base', '--is-ancestor', item.commit, tip]) === null
        || git(root, ['merge-base', '--is-ancestor', item.merge, tip]) === null) return 'item commit is not in the landed tip';
  }
  const status = git(path, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status === null) return 'worktree status unavailable';
  if (status) return 'dirty worktree or untracked files';
  const ignored = git(path, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']);
  if (ignored === null) return 'ignored-file observation unavailable';
  return ignored ? 'ignored files remain' : null;
}

/**
 * Prune only exact retired targets after local safety checks and a final authoritative revalidation.
 * Unknown observations keep the checkout. This is best effort, not an OS lock against external chdir.
 * Board retirement and adoption remain the parent's responsibility; no branch is ever deleted.
 */
export async function pruneRetiredWorktrees(root, { tip, targets, exclude = [], revalidate, say = () => {} }) {
  const commonValue = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!commonValue) throw new Error('cannot prove the landing repository; no worktree was removed');
  const common = realpathSync(commonValue.trim());
  const directory = join(common, 'pullboard', 'worktree-prune');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const receipt = join(directory, randomUUID() + '.json');
  const document = { version: 1, tip, startedAt: new Date().toISOString(), attempts: [] };
  const result = { removed: [], skipped: [], receipt };
  /** Save intent and final outcomes atomically, retaining no global process-cwd observations. */
  const persist = () => {
    const temporary = receipt + '.tmp';
    writeFileSync(temporary, JSON.stringify(document, null, 2) + '\n', { mode: 0o600 });
    renameSync(temporary, receipt);
  };
  /** Keep and name every uncertain target; already committed landing history is unaffected. */
  const skip = (entry, reason, pids = []) => {
    Object.assign(entry, { action: 'kept', reason, ...(pids.length ? { pids } : {}) });
    result.skipped.push({ ...entry });
    persist();
    say(`kept ${entry.agent ?? 'unknown seat'} ${JSON.stringify(entry.path)}: ${reason}`);
  };
  persist();
  for (const target of Array.isArray(targets) ? targets : []) {
    const entry = { ...receiptTarget(target), action: 'checking' };
    document.attempts.push(entry);
    persist();
    const invalid = targetProblem(target, tip);
    if (invalid) { skip(entry, invalid); continue; }
    if (typeof revalidate !== 'function') { skip(entry, 'board revalidation unavailable'); continue; }
    if (!Array.isArray(exclude) || exclude.some(path => typeof path !== 'string' || !isAbsolute(path))) { skip(entry, 'invalid exclusions'); continue; }
    const problem = localProblem(root, common, target, tip, exclude);
    if (problem) { skip(entry, problem); continue; }
    const rows = workingDirectories();
    if (!rows) { skip(entry, 'process cwd observation unavailable'); continue; }
    const pids = rows.filter(row => contains(target.path, row.path) || contains(target.path, row.path.replace(/ \(deleted\)$/u, ''))).map(row => row.pid);
    if (pids.length) { skip(entry, 'worktree is in use as a process cwd', pids); continue; }
    const refreshed = localProblem(root, common, target, tip, exclude);
    if (refreshed) { skip(entry, refreshed); continue; }
    entry.action = 'remove-pending-revalidation';
    persist();
    let changed;
    try { changed = await revalidate(target); } catch { changed = 'board revalidation failed'; }
    if (changed !== null) { skip(entry, typeof changed === 'string' && changed ? changed : 'board revalidation did not confirm retirement'); continue; }
    // No further asynchronous operation separates the parent's final check from ordinary Git removal.
    const removed = git(root, ['worktree', 'remove', '--', target.path]);
    if (removed === null || existsSync(target.path)) { skip(entry, 'non-force worktree removal refused'); continue; }
    entry.action = 'removed';
    result.removed.push({ ...entry });
    persist();
    say(`removed ${entry.agent} ${JSON.stringify(entry.path)}`);
  }
  document.finishedAt = new Date().toISOString();
  persist();
  return result;
}
