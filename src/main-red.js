/** Fresh per-file main comparisons for inherited submit reds [V1]. */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { runProfiledShell, withGateSlot } from './gate.js';
import { cleanGitEnvironment, mainCheckout } from './git.js';
import { mainPolicy, policyAt } from './trusted-policy.js';
import { parseSpec } from './spec.js';
import { listItems } from './board.js';
import { takeResource } from './resources.js';
import { Refused } from './refused.js';

const CACHE_RELATIVE = 'pullboard/main-red.json';

/** Quote one shell argument appended to the configured focused test command. */
function shellWord(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** Resolve one test filename from runner output to a safe repository-relative path. */
function testPath(root, value) {
  if (typeof value !== 'string' || !value) return null;
  const absolute = resolve(root, value);
  const path = relative(root, absolute);
  if (!path || path === '..' || path.startsWith(`..${sep}`) || path.startsWith(sep)) return null;
  return path.split(sep).join('/');
}

/** Unique failed test files actually named by the runner profile. */
function failingFiles(root, profile) {
  const files = new Set();
  for (const test of profile?.tests ?? []) if (test.passed === false) {
    const path = testPath(root, test.file);
    if (path) files.add(path);
  }
  // TAP file rows represent crashes; JUnit suite rows include passing files too.
  const formats = String(profile?.format ?? '').split('+');
  if (formats.includes('tap') && !formats.includes('junit')) {
    for (const file of profile?.files ?? []) {
      const path = testPath(root, file.path);
      if (path) files.add(path);
    }
  }
  return [...files].sort();
}

/** The common Git directory holds local machine evidence shared by this repo's worktrees. */
function cacheFile(root) {
  const result = spawnSync('git', ['--no-replace-objects', 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: root, env: cleanGitEnvironment(), encoding: 'utf8',
  });
  if (result.status !== 0) throw new Refused('NO_POLICY', 'the repository common Git directory cannot be read for the local main comparison cache');
  return join(result.stdout.trim(), CACHE_RELATIVE);
}

/** Read only well-formed, machine-local cached outcomes; malformed data is treated as a miss. */
function readCache(file) {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > 4 * 1024 * 1024) return { version: 1, entries: {} };
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (value.version !== 1 || !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) return { version: 1, entries: {} };
    const entries = {};
    for (const [commit, files] of Object.entries(value.entries)) {
      if (!/^[0-9a-f]{40,64}$/u.test(commit) || !files || typeof files !== 'object' || Array.isArray(files)) continue;
      entries[commit] = {};
      for (const [path, outcome] of Object.entries(files)) {
        if (typeof path === 'string' && path && ['red', 'green'].includes(outcome?.result)) entries[commit][path] = { result: outcome.result };
      }
    }
    return { version: 1, entries };
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, entries: {} };
    return { version: 1, entries: {} };
  }
}

/** Atomically persist a focused result without writing anything to board state or the worktree. */
function writeCache(file, value) {
  const directory = join(file, '..');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Run Git with repository selectors cleared, keeping the main snapshot isolated. */
function gitCall(cwd, args, env) {
  return spawnSync('git', ['--no-replace-objects', ...args], {
    cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024,
  });
}

/** Build one clean temporary checkout at the exact main commit and always remove it. */
function withMainCheckout(root, commit, run) {
  const directory = join(tmpdir(), `pullboard-main-red-${randomUUID()}`);
  mkdirSync(directory, { mode: 0o700 });
  const checkout = join(directory, 'checkout');
  const env = cleanGitEnvironment();
  try {
    const cloned = gitCall(root, ['clone', '--quiet', '--shared', '--no-checkout', '--', root, checkout], env);
    if (cloned.status !== 0) return { unavailable: 'temporary main checkout could not be prepared' };
    const selected = gitCall(checkout, ['checkout', '--quiet', '--force', '--detach', commit], env);
    if (selected.status !== 0) return { unavailable: 'the exact main commit could not be checked out temporarily' };
    const clean = gitCall(checkout, ['status', '--porcelain', '--untracked-files=all'], env);
    const head = gitCall(checkout, ['rev-parse', '--verify', 'HEAD^{commit}'], env);
    if (clean.status !== 0 || clean.stdout !== '' || head.status !== 0 || head.stdout.trim() !== commit) {
      return { unavailable: 'the temporary main checkout was not clean at the captured commit' };
    }
    return run(checkout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Compare named failed files against one captured main snapshot. Each result is cached by exact
 * commit and file; later submits reuse completed results rather than rerunning the same file.
 *
 * @param {string} root
 * @param {object} profile
 * @param {(state:object)=>void} [onWait]
 * @returns {Promise<{ main: string|null, files: Array<{file:string,result:'red'|'green'}>, unavailable?: string }>}
 */
export async function compareMainFailures(root, profile, onWait) {
  const main = mainCheckout(root);
  if (!main?.commit) return { main: null, files: [], unavailable: 'the primary checkout has no committed main snapshot' };
  const policy = policyAt(root, main.commit);
  if (typeof policy.config.affectedTests !== 'string' || !policy.config.affectedTests.trim()) {
    return { main: main.commit, files: [], unavailable: 'no focused test runner configured' };
  }
  const files = failingFiles(root, profile);
  if (!files.length) return { main: main.commit, files: [], unavailable: 'the runner did not name failed test files' };
  const file = cacheFile(root);
  const cacheLease = await takeResource({
    name: 'main-red-cache', capacity: 1, scope: 'repo', root,
    agent: process.env.PULLBOARD_AGENT ?? `pid-${process.pid}`,
    onWait,
  });
  try { return await withGateSlot(root, () => {
    let cache = readCache(file);
    const results = [];
    const missing = files.filter(path => !['red', 'green'].includes(cache.entries[main.commit]?.[path]?.result));
    if (missing.length) {
      const outcomes = {};
      for (const path of missing) {
        const measured = withMainCheckout(root, main.commit, checkout => {
          const command = `${policy.config.affectedTests.trimEnd()} ${shellWord('./' + path)}`;
          const run = runProfiledShell(checkout, command, { gateSlotHeld: true });
          return { result: run.isGreen ? 'green' : 'red' };
        });
        if (measured.unavailable) return { main: main.commit, files: [], unavailable: measured.unavailable };
        outcomes[path] = measured;
      }
      cache = readCache(file);
      const prior = cache.entries[main.commit] && typeof cache.entries[main.commit] === 'object' && !Array.isArray(cache.entries[main.commit])
        ? cache.entries[main.commit] : {};
      cache.entries[main.commit] = { ...prior, ...outcomes };
      try { writeCache(file, cache); }
      catch { return { main: main.commit, files: [], unavailable: 'main results could not be saved to the machine-local cache' }; }
    }
    for (const path of files) results.push({ file: path, result: cache.entries[main.commit][path].result });
    return { main: main.commit, files: results };
  }, { onWait });
  } finally { cacheLease.release(); }
}

/** Map one or more main-red file results only when the row and its open owner are unambiguous. */
export function mainRedAttribution(root, board, comparison) {
  const redFiles = comparison.files.filter(entry => entry.result === 'red').map(entry => entry.file);
  if (!redFiles.length || !comparison.main) return { redFiles, row: null, item: null };
  const matches = matchingReworks(root, board, comparison.main, redFiles);
  return matches.length === 1
    ? { redFiles, ...matches[0] }
    : { redFiles, row: null, item: null };
}

/** Add only evidence the exact-main focused reruns established to an existing GATE_RED refusal. */
export function mainRedMessage(root, board, profile, comparison) {
  if (comparison.unavailable === 'no focused test runner configured') {
    return 'main not checked: no focused test runner configured (affectedTests)';
  }
  if (!comparison.files.length) return '';
  const attribution = mainRedAttribution(root, board, comparison);
  const names = (profile?.tests ?? []).filter(test => test.passed === false)
    .map(test => test.name ? `${test.file ?? 'unknown file'} (${test.name})` : test.file)
    .filter(Boolean);
  const redFiles = attribution.redFiles;
  if (!redFiles.length) return '';
  if (attribution.item && attribution.row) {
    const file = attribution.file;
    const testNames = names.length ? `: ${names.join(', ')}` : '';
    return `inherited main red for approved row ${attribution.row.id} (${file}${testNames}); open rework #${attribution.item.item_id} owns it\nnext: land #${attribution.item.item_id} first, then submit again`;
  }
  return `also red on main: ${redFiles.join(', ')}${names.length ? ` (${names.join(', ')})` : ''}`;
}

/** Current-main red files that uniquely identify one approved row and one open rework item. */
export function mainRedReworkItems(root, board) {
  const main = mainCheckout(root);
  if (!main?.commit) return [];
  let cache;
  let policy;
  try {
    cache = readCache(cacheFile(root));
    policy = mainPolicy(root);
  } catch { return []; }
  if (policy.commit !== main.commit) return [];
  const current = cache.entries[main.commit];
  if (!current) return [];
  let spec;
  try {
    const result = gitCall(root, ['show', `${main.commit}:${policy.config.spec}`], cleanGitEnvironment());
    if (result.status !== 0) return [];
    spec = parseSpec(result.stdout, { strictGrammarVersion: false });
  } catch { return []; }
  const redFiles = Object.entries(current).filter(([, result]) => result.result === 'red').map(([path]) => path);
  const matches = matchingReworks(root, board, main.commit, redFiles, { policy, spec, items: listItems(board, { all: true }) });
  return matches.length === 1 ? [matches[0].item.item_id] : [];
}

/** Resolve exact-main approved rows and open items without using the candidate's spec text. */
function matchingReworks(root, board, commit, files, loaded = null) {
  let policy = loaded?.policy;
  let spec = loaded?.spec;
  let items = loaded?.items;
  try {
    policy ??= policyAt(root, commit);
    if (!spec) {
      const result = gitCall(root, ['show', `${commit}:${policy.config.spec}`], cleanGitEnvironment());
      if (result.status !== 0) return [];
      spec = parseSpec(result.stdout, { strictGrammarVersion: false });
    }
    items ??= listItems(board, { all: true });
  } catch { return []; }
  const open = items.filter(item => item.item_status === 'open');
  const matches = [];
  for (const file of files) {
    const rows = spec.rows.filter(row => row.status === 'approved' && row.gate === file);
    if (rows.length !== 1) continue;
    const row = rows[0];
    const owners = open.filter(item => item.item_spec_ids.split(',').map(id => id.trim()).includes(row.id));
    if (owners.length === 1) matches.push({ file, row, item: owners[0] });
  }
  return matches;
}
