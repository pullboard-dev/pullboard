/** The cells-plan placement check on a recorded landing commit, the one automatic landing applies [C7]. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanGitEnvironment } from '../../../../git/index.js';
import { Refused } from '../../../../kernel/index.js';
import { ENGINE_CANDIDATE } from '../../../../kernel/index.js';
import { gitSpawnSync } from '../../../../git/index.js';
import { gateRunnerAdmission } from '../../../../config/index.js';
import { runCheckOnRunner } from '../main/red.js';
import { landingPlanProblems } from '../../../../codemap/index.js';

/** The folder the engine leaves live in; landing numbers only the placeholders there [V4]. */
const ENGINE_FOLDER = 'packages/state/src/logic/engines';

/** Recognize the canonical placeholder declaration automatic landing numbers, without executing candidate code. */
function unnumberedEngine(source) {
  const lines = source.split('\n');
  const declarations = lines.filter(line => /^export const /u.test(line));
  return lines.includes("import { unassignedEngine } from './engine-next.js';") && declarations.length === 1
    && /^export const [A-Z][A-Z0-9_]*_ENGINE = unassignedEngine\(\);$/u.test(declarations[0]);
}

/**
 * Check a commit against its plan from Git objects alone: the plan comes from `git show <commit>:packages/codemap/data/plan/cells.json`
 * and its shards, the paths from `git ls-tree -r <commit>`, so the check adds no worktree [C7].
 * Why objects: a checkout per merged cost a worktree add and remove just to read tracked bytes.
 * @param {string} root A checkout of the repository.
 * @param {string} commit The commit about to be recorded as merged.
 * @param {NodeJS.ProcessEnv} env A clean Git environment.
 * @returns {boolean|null} True when it passed, null when the commit's plan is not a Pullboard cells plan.
 */
function checkFromObjects(root, commit, env) {
  let result;
  try { result = landingPlanProblems(root, commit, env); }
  catch (error) { throw new Refused('LAND_PLAN_CHECK', `could not read landing commit ${commit.slice(0, 12)}: ${String(error?.message ?? error).split('\n')[0]}; restore its Git objects and retry merged`); }
  if (result === null) return null;
  const { unplaced, lines } = result;
  if (!unplaced.length && !lines.length) return true;
  const detail = unplaced.length ? `unplaced paths: ${unplaced.join(', ')}` : lines.join('; ');
  throw new Refused('LAND_PLAN_UNPLACED', `${commit.slice(0, 12)} fails the cells-plan check (${detail}); place each path with node packages/codemap/src/io/cells/scripts/plan.js --place <path> --cell <cell> (or --stay), commit it, and record that commit`);
}

/** Refuse a failed plan check run, naming its unplaced or stale paths; a passing run returns. */
function judgePlanRun(run, commit) {
  if (run.status === 0) return;
  const lines = `${run.stderr}\n${run.stdout}`.split('\n').filter(line => /^(not in packages\/codemap\/data\/plan\/cells\.json:|stale plan row|.*(CELLS_|retired historical))/u.test(line));
  const unplaced = lines.filter(line => line.startsWith('not in packages/codemap/data/plan/cells.json:')).map(line => line.slice(line.indexOf(':') + 1).trim());
  const detail = unplaced.length ? `unplaced paths: ${unplaced.join(', ')}` : (lines.join('; ') || run.stderr.trim().split('\n').pop() || 'the check failed');
  throw new Refused('LAND_PLAN_UNPLACED', `${commit.slice(0, 12)} fails the cells-plan check (${detail}); place each path with node packages/codemap/src/io/cells/scripts/plan.js --place <path> --cell <cell> (or --stay), commit it, and record that commit`);
}

/**
 * Check out a commit detached in a scratch worktree so its own `packages/codemap/src/io/cells/scripts/plan.js --check` can run there.
 * @param {string} root A checkout of the repository.
 * @param {string} commit The commit about to be recorded as merged.
 * @param {NodeJS.ProcessEnv} env A clean Git environment.
 * @returns {{ tree: string, cleanup: () => void }} The checkout and the call that removes it.
 */
function scratchTree(root, commit, env) {
  const scratch = mkdtempSync(join(tmpdir(), 'pullboard-landing-plan-'));
  const tree = join(scratch, 'tree');
  const cleanup = () => {
    gitSpawnSync(['worktree', 'remove', '--force', tree], { cwd: root, env });
    rmSync(scratch, { recursive: true, force: true });
  };
  const add = gitSpawnSync(['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', tree, commit], { cwd: root, env, encoding: 'utf8' });
  if (add.status !== 0) {
    cleanup();
    throw new Refused('LAND_PLAN_CHECK', `could not check out ${commit.slice(0, 12)} to run the cells-plan check: ${add.stderr.trim()}; retry merged`);
  }
  return { tree, cleanup };
}

/**
 * Check a commit whose plan is not a Pullboard cells plan by running that commit's own `packages/codemap/src/io/cells/scripts/plan.js --check`
 * in a scratch worktree, so a foreign repository keeps meeting its own rules.
 * @param {string} root A checkout of the repository.
 * @param {string} commit The commit about to be recorded as merged.
 * @param {NodeJS.ProcessEnv} env A clean Git environment.
 * @returns {void}
 */
function checkInScratchTree(root, commit, env) {
  const { tree, cleanup } = scratchTree(root, commit, env);
  try {
    judgePlanRun(spawnSync(process.execPath, ['packages/codemap/src/io/cells/scripts/plan.js', '--check'], { cwd: tree, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024 }), commit);
  } finally { cleanup(); }
}

/**
 * The same check on a runner: the commit's own `packages/codemap/src/io/cells/scripts/plan.js --check` queues for one and never runs as a local process.
 * @param {string} root A checkout of the repository.
 * @param {string} commit The commit about to be recorded as merged.
 * @param {NodeJS.ProcessEnv} env A clean Git environment.
 * @param {object} admission The captured runner admission.
 * @returns {Promise<void>}
 */
async function checkOnRunner(root, commit, env, admission) {
  const { tree, cleanup } = scratchTree(root, commit, env);
  try {
    const run = await runCheckOnRunner(tree, 'node packages/codemap/src/io/cells/scripts/plan.js --check', { kind: 'landing-plan', admission });
    judgePlanRun({ status: run.isGreen ? 0 : 1, stdout: String(run.output ?? ''), stderr: '' }, commit);
  } finally { cleanup(); }
}

/**
 * Run the cells-plan check on the recorded commit so a hand-landed commit meets the same placement, plan-row and
 * numbered-engine rules as an automatic landing. A commit with no plan still checks opted-in engine leaves.
 * A Pullboard cells plan is checked from Git objects with no worktree; any other plan runs its own tool in a scratch tree.
 * @param {string} root A checkout of the repository.
 * @param {string} commit The commit about to be recorded as merged.
 * @returns {void} Nothing; a failing check throws a refusal naming the unplaced or stale paths.
 */
export function requireLandingPlanCheck(root, commit) {
  const foreign = planChecks(root, commit);
  if (foreign) checkInScratchTree(root, commit, foreign.env);
}

/**
 * The same check where this machine runs checks: with gate.runnersOnly on, a plan that is not a Pullboard cells plan
 * runs its own `packages/codemap/src/io/cells/scripts/plan.js --check` on a runner, queueing for one and never as a local process (#3011).
 * @param {string} root A checkout of the repository.
 * @param {string} commit The commit about to be recorded as merged.
 * @param {{ admission?: object }} [options] The captured runner admission.
 * @returns {Promise<void>} Nothing; a failing check throws the same refusals.
 */
export async function landingPlanCheck(root, commit, { admission = gateRunnerAdmission() } = {}) {
  const foreign = planChecks(root, commit);
  if (!foreign) return;
  if (admission.runnerOnly !== true) return checkInScratchTree(root, commit, foreign.env);
  await checkOnRunner(root, commit, foreign.env, admission);
}

/**
 * Judge everything that needs no tool run: engine numbering and a Pullboard cells plan from Git objects.
 * @param {string} root A checkout of the repository.
 * @param {string} commit The commit about to be recorded as merged.
 * @returns {{ env: NodeJS.ProcessEnv }|null} Set when the commit's own plan tool must still run, else null.
 */
function planChecks(root, commit) {
  const env = cleanGitEnvironment();
  const listed = gitSpawnSync(['ls-tree', '-r', '-z', commit, '--', 'packages/codemap/data/plan/cells.json', `${ENGINE_FOLDER}/`], { cwd: root, env, encoding: 'utf8' });
  if (listed.status !== 0) throw new Refused('LAND_PLAN_CHECK', `could not read landing commit ${commit.slice(0, 12)}; restore its Git objects and retry merged`);
  const rows = listed.stdout.split('\0').filter(Boolean).map(row => /^(\d{6}) \w+ ([a-f0-9]{40,64})\t([\s\S]+)$/u.exec(row)).filter(Boolean)
    .map(match => ({ mode: match[1], object: match[2], path: match[3] }));
  const hasPlan = rows.some(row => row.path === 'packages/codemap/data/plan/cells.json');
  const leaf = row => row.path.slice(ENGINE_FOLDER.length + 1);
  const candidates = rows.filter(row => row.path.startsWith(`${ENGINE_FOLDER}/`) && !leaf(row).includes('/') && ENGINE_CANDIDATE.test(leaf(row)));
  if (!hasPlan && !candidates.length) return null;
  const pending = candidates.filter(row => {
    if (!/^100(?:644|755)$/u.test(row.mode)) throw new Refused('LAND_PLAN_CHECK', `engine leaf ${row.path} must be a regular source file before recording merged`);
    const blob = gitSpawnSync(['cat-file', 'blob', row.object], { cwd: root, env, encoding: 'utf8', maxBuffer: 16 * 1024 ** 2 });
    if (blob.status !== 0) throw new Refused('LAND_PLAN_CHECK', `could not read engine leaf ${row.path} at ${commit.slice(0, 12)}; restore its Git objects and retry merged`);
    return unnumberedEngine(blob.stdout);
  }).map(row => row.path);
  if (pending.length) throw new Refused('LAND_ENGINE_UNNUMBERED', `${commit.slice(0, 12)} leaves unnumbered engines: ${pending.join(', ')}; run amendLandingEngines during landing to assign their numbers, then record the resulting commit`);
  if (!hasPlan) return null;
  return checkFromObjects(root, commit, env) === null ? { env } : null;
}
