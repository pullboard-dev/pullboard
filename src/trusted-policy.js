/** Coordinator policy and immutable submission checks cannot come from a builder's candidate [V4,V16,L3,M3]. */
import { spawnSync } from 'node:child_process';
import { digestOf } from './gate.js';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configFromSource } from './config.js';
import { cleanGitEnvironment, mainCheckout } from './git.js';
import { outOfLane } from './lanes.js';
import { Refused } from './refused.js';

/** Read raw Git output, retaining NUL-delimited names without exposing Git diagnostics. */
function policyGit(root, args) {
  const result = spawnSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: root, env: cleanGitEnvironment(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Refused('NO_POLICY', 'the committed coordinator policy or claim base is missing; restore its Git objects or ask the coordinator to refreeze the item');
  return result.stdout;
}

/** Resolve the primary checkout's committed HEAD, independently of a linked or detached checkout. */
export function mainPolicy(root) {
  const checkout = mainCheckout(root);
  if (!checkout) throw new Refused('NO_POLICY', 'the coordinator checkout is detached for review; ask it to return to its main branch before claiming or running the project gate');
  if (!checkout.commit) throw new Refused('NO_POLICY', 'the coordinator checkout has no commit on ' + checkout.branch + '; create its first commit before claiming or running the project gate');
  return policyAt(root, checkout.commit);
}

/** Retain the local primary branch outside replicated board data and read-only diagnostics [B34,V6]. */
export function trunkRef(root, branch) {
  const read = spawnSync('git', ['--no-replace-objects', 'config', '--local', '--get', 'pullboard.trunk'], {
    cwd: root, env: cleanGitEnvironment(), encoding: 'utf8',
  });
  if (read.status !== 0 && read.status !== 1) throw new Refused('NO_POLICY', 'the retained trunk cannot be read; restore the local Git configuration and retry');
  const current = read.status === 0 ? read.stdout.trim() : null;
  if (branch === undefined || branch === current) return current;
  const saved = spawnSync('git', ['--no-replace-objects', 'config', '--local', '--replace-all', 'pullboard.trunk', branch], {
    cwd: root, env: cleanGitEnvironment(), encoding: 'utf8',
  });
  if (saved.status !== 0) throw new Refused('NO_POLICY', 'the trunk branch cannot be recorded; restore writable local Git configuration and retry');
  return branch;
}

/** Refuse a candidate that conflicts with the current primary branch, without touching an index or worktree [B34,V6]. */
export function requireTrunkMerge(root, commit, retainedRef = trunkRef(root)) {
  const checkout = mainCheckout(root);
  const branchRef = checkout?.branch ?? retainedRef;
  if (!branchRef?.startsWith('refs/heads/')) throw new Refused('NO_TRUNK', 'no trunk branch was recorded; check out the trunk branch in the main checkout once and run pullboard inbox');
  const tip = spawnSync('git', ['--no-replace-objects', 'rev-parse', '--verify', '--quiet', branchRef + '^{commit}'], { cwd: root, env: cleanGitEnvironment(), encoding: 'utf8' });
  if (tip.status !== 0) throw new Refused('NO_TRUNK', 'the recorded trunk branch has no readable tip; check out the trunk branch in the main checkout once and run pullboard inbox');
  const result = spawnSync('git', ['--no-replace-objects', '-c', 'core.quotepath=false', 'merge-tree', '--write-tree', '--name-only', '-z', tip.stdout.trim(), commit], {
    cwd: root, env: cleanGitEnvironment(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status === 0) return;
  if (result.status !== 1) throw new Refused('MERGE_CHECK_FAILED', 'Git could not check the candidate against the trunk; use Git 2.38 or newer, restore its objects and retry');
  const records = result.stdout.split('\0').slice(1);
  const end = records.indexOf('');
  const files = records.slice(0, end < 0 ? records.length : end).map(path => JSON.stringify(path));
  const branch = branchRef.replace(/^refs\/heads\//, '');
  throw new Refused('MERGE_CONFLICT', `the candidate conflicts with the current trunk ${branch} in ${files.join(', ') || 'unresolved files'}; merge the trunk into your branch, resolve these files, commit and resubmit`);
}

/** Re-read coordinator settings from a pinned Git object; never from the candidate filesystem. */
export function policyAt(root, commit) {
  if (!/^[0-9a-f]{40,64}$/.test(commit ?? '')) throw new Refused('NO_POLICY', 'this item has no recorded claim base; ask the coordinator to refreeze it and claim it again');
  const config = configFromSource(policyGit(root, ['show', commit + ':pullboard.json']));
  return { version: 1, commit, config };
}

/** Use new claims' frozen policy; legacy claims retain their committed claim-base settings. */
export function itemPolicy(root, item) {
  let frozen;
  try { frozen = JSON.parse(item.item_frozen ?? 'null'); }
  catch { throw new Refused('NO_POLICY', 'the frozen criterion is invalid; ask the coordinator to refreeze this item'); }
  return policyAt(root, frozen?.policy?.commit ?? item.item_claim_head);
}

/** Compare a path's mode and object, including deletions, against an authenticated main snapshot. */
function pathObject(root, commit, path) {
  return policyGit(root, ['ls-tree', '-z', commit, '--', ':(literal)' + path]);
}

/** Enforce the complete claim-base diff; accepted-main merges may carry only identical foreign objects. */
export function submissionPaths(root, item, commit, { config, mainCommit, dependencies = [] } = {}) {
  const policy = itemPolicy(root, item);
  const base = item.item_claim_head;
  if (!/^[0-9a-f]{40,64}$/.test(base ?? '')) throw new Refused('NO_POLICY', 'this item has no claim base; ask the coordinator to refreeze it and claim again');
  policyGit(root, ['rev-parse', '--verify', base + '^{commit}']);
  const changed = [base, policy.commit].flatMap(start => policyGit(root, ['diff', '--no-renames', '--name-only', '-z', start, commit, '--']).split('\0').filter(Boolean));
  const paths = [...new Set(changed)];
  const ownership = config ?? policy.config;
  const foreign = paths.filter(path => outOfLane(ownership, item.item_lane, [path]).length);
  const snapshot = mainCommit ?? policy.commit;
  policyAt(root, snapshot); // Reject a malformed historical proof before it can become a Git argument.
  const accepted = dependencies.map(dependency => ({ ...dependency,
    paths: new Set(policyGit(root, ['diff', '--no-renames', '--name-only', '-z', dependency.base, dependency.commit, '--']).split('\0').filter(Boolean)),
  }));
  const denied = foreign.filter(path => {
    const object = pathObject(root, commit, path);
    if (object === pathObject(root, snapshot, path)) return false;
    return !accepted.some(dependency => dependency.paths.has(path)
      && !outOfLane(ownership, dependency.lane, [path]).length
      && object === pathObject(root, dependency.commit, path));
  });
  if (denied.length) throw new Refused('OUTSIDE_LANE', 'outside the ' + item.item_lane + ' lane: ' + outOfLane(ownership, item.item_lane, denied).join(', ') + '; shout the owner and restore these paths before submitting');
  return paths;
}

/** Verified dependencies may contribute their own unchanged lane files before the coordinator merges them [N16]. */
export function dependencySnapshots(db, item) {
  const ids = String(item.item_after ?? '').split(',').map(Number).filter(id => Number.isSafeInteger(id) && id > 0);
  return ids.flatMap(id => {
    const row = db.prepare("SELECT item_lane, item_claim_head, item_commit FROM item WHERE item_id=? AND item_status='verified' AND EXISTS (SELECT 1 FROM verdict WHERE item_id=? AND verdict_decision='ACCEPT' AND verdict_commit=item.item_commit)").get(id, id);
    return row?.item_claim_head && /^[0-9a-f]{40,64}$/.test(row.item_commit ?? '')
      ? [{ lane: row.item_lane, base: row.item_claim_head, commit: row.item_commit }] : [];
  });
}

/** Read the command frozen with the criterion, preventing a later edit from changing its proof. */
export function frozenCheck(item) {
  let frozen;
  try { frozen = JSON.parse(item.item_frozen ?? 'null'); } catch { return ''; }
  return frozen?.check ?? (item.item_frozen ? '' : item.item_check ?? '');
}

/** Run the frozen check at the exact submitted commit in a private clone, leaving live worktrees untouched. */
export function checkAtCommit(root, item) {
  const command = frozenCheck(item);
  if (!command) return { state: 'pass', green: true, checked: false, report: '' };
  let config;
  try { config = itemPolicy(root, item).config; }
  catch { return checkResult('unverified', 'policy', '', ''); }
  const install = config.check.install;
  const timeout = config.check.timeoutMs;
  const scratch = mkdtempSync(join(tmpdir(), 'pullboard-criterion-'));
  const copy = join(scratch, 'repo');
  const home = join(scratch, 'home');
  mkdirSync(home, { mode: 0o700 });
  const verifierHome = process.env.HOME ?? process.env.USERPROFILE;
  const npmCache = process.env.npm_config_cache ?? join(verifierHome ?? home, '.npm');
  const env = { ...cleanGitEnvironment(), HOME: home, PULLBOARD_HOME: join(home, '.pullboard'), PULLBOARD_MACHINE_HOME: join(home, 'machine'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', npm_config_cache: npmCache };
  delete env.PULLBOARD_RELAY_TOKEN;
  let installOutput = '';
  let checkOutput = '';
  try {
    const common = policyGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
    const clone = spawnSync('git', ['clone', '--quiet', '--shared', '--no-checkout', common, copy], { env, stdio: 'ignore' });
    const checkout = clone.status === 0 && spawnSync('git', ['checkout', '--quiet', '--detach', item.item_commit], { cwd: copy, env, stdio: 'ignore' });
    if (!checkout || checkout.status !== 0) return checkResult('unverified', 'clone or checkout', installOutput, checkOutput);
    const deadline = Date.now() + timeout;
    if (install) {
      const run = runPrivateCommand(copy, env, install, Math.max(1, deadline - Date.now()), join(scratch, 'install.log'));
      installOutput = run.output;
      if (run.error?.code === 'ETIMEDOUT') return checkResult('unverified', 'install timed out', installOutput, checkOutput);
      if (run.status !== 0) return checkResult('unverified', 'install failed', installOutput, checkOutput);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return checkResult('unverified', 'check timed out', installOutput, checkOutput);
    const run = runPrivateCommand(copy, env, command, remaining, join(scratch, 'check.log'));
    checkOutput = run.output;
    if (run.error?.code === 'ETIMEDOUT') return checkResult('unverified', 'check timed out', installOutput, checkOutput);
    if (run.error || run.status === null) return checkResult('unverified', 'check could not complete', installOutput, checkOutput);
    return checkResult(run.status === 0 ? 'pass' : 'red', 'check', installOutput, checkOutput);
  } catch { return checkResult('unverified', 'check', installOutput, checkOutput); }
  finally { rmSync(scratch, { recursive: true, force: true }); }
}

/** Run one shell command in a bounded private process group and capture its combined output. */
function runPrivateCommand(root, env, command, timeout, logPath) {
  const pidFile = logPath + '.pid';
  try {
    // The worker drains pipes even after its capture cap, so noisy successful commands still pass.
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('./private-check-worker.js', import.meta.url))], {
      cwd: root, env, input: JSON.stringify({ command, timeout, pidFile }), encoding: 'utf8',
      timeout: timeout + 1000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024,
    });
    if (run.error) return { status: null, error: { code: run.error.code }, output: '' };
    try { return JSON.parse(run.stdout); }
    catch { return { status: null, error: { code: 'CHECK_RUNNER' }, output: '' }; }
  } finally {
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8'));
      if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid) {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* The private command group has already exited. */ }
      }
      rmSync(pidFile, { force: true });
    }
  }
}

/** Summarize both private command outputs for verifier and doctor diagnostics. */
function checkResult(state, stage, installOutput, checkOutput) {
  const install = digestOf(installOutput) || '(no output)';
  const check = digestOf(checkOutput) || '(not run or no output)';
  const output = `install:\n${installOutput || '(no output)'}\ncheck:\n${checkOutput || '(not run or no output)'}`;
  return { state, green: state === 'pass', checked: true, stage, report: `install output:\n${install}\ncheck output:\n${check}`, output };
}
