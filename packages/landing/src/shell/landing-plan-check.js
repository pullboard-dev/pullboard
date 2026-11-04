/** The cells-plan placement check on a recorded landing commit, the one automatic landing applies [C7]. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { lstatSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanGitEnvironment } from '../../../git/index.js';
import { Refused } from '../../../kernel/index.js';
import { ENGINE_CANDIDATE } from '../../../kernel/index.js';
import { gateRunnerAdmission } from '../../../config/index.js';
import { runCheckOnRunner } from './landing-runner-check.js';

/** Recognize the canonical placeholder declaration automatic landing numbers, without executing candidate code. */
function unnumberedEngine(source) {
  const lines = source.split('\n');
  const declarations = lines.filter(line => /^export const /u.test(line));
  return lines.includes("import { unassignedEngine } from './engine-next.js';") && declarations.length === 1
    && /^export const [A-Z][A-Z0-9_]*_ENGINE = unassignedEngine\(\);$/u.test(declarations[0]);
}

/**
 * Check out the commit detached in a scratch worktree and run its own `bin/cells-plan.js --check`, so a hand-landed
 * commit meets the same placement, plan-row and numbered-engine rules as an automatic landing. A commit with no plan still checks opted-in engine leaves.
 * Why a checkout: the check reads tracked files, shards and path maps from disk, so only a real tree answers for the commit.
 * @param {string} root A checkout of the repository.
 * @param {string} commit The commit about to be recorded as merged.
 * @returns {void} Nothing; a failing check throws a refusal naming the unplaced or stale paths.
 */
export function requireLandingPlanCheck(root, commit) {
  const prepared = preparePlanTree(root, commit);
  if (!prepared) return;
  try {
    if (prepared.hasPlan) judgePlanRun(spawnSync(process.execPath, ['bin/cells-plan.js', '--check'], { cwd: prepared.tree, env: prepared.env, encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024 }), commit);
  } finally { prepared.cleanup(); }
}

/**
 * The same check where this machine runs checks: with gate.runnersOnly on, `bin/cells-plan.js --check` queues for a
 * runner and never runs as a local process; otherwise it runs here as requireLandingPlanCheck does (#3011).
 * @param {string} root A checkout of the repository.
 * @param {string} commit The commit about to be recorded as merged.
 * @param {{ admission?: object }} [options] The captured runner admission.
 * @returns {Promise<void>} Nothing; a failing check throws the same refusals.
 */
export async function landingPlanCheck(root, commit, { admission = gateRunnerAdmission() } = {}) {
  if (admission.runnerOnly !== true) return requireLandingPlanCheck(root, commit);
  const prepared = preparePlanTree(root, commit);
  if (!prepared) return;
  try {
    if (!prepared.hasPlan) return;
    const run = await runCheckOnRunner(prepared.tree, 'node bin/cells-plan.js --check', { kind: 'landing-plan', admission });
    judgePlanRun({ status: run.isGreen ? 0 : 1, stdout: String(run.output ?? ''), stderr: '' }, commit);
  } finally { prepared.cleanup(); }
}

/** List the commit's plan and engine leaves, check out a scratch tree and refuse unnumbered engines; null when nothing applies. */
function preparePlanTree(root, commit) {
  const env = cleanGitEnvironment();
  const listed = spawnSync('git', ['ls-tree', '-r', '-z', '--name-only', commit, '--', 'bin/cells-plan.json', 'src/'], { cwd: root, env, encoding: 'utf8' });
  if (listed.status !== 0) throw new Refused('LAND_PLAN_CHECK', `could not read landing commit ${commit.slice(0, 12)}; restore its Git objects and retry merged`);
  const paths = listed.stdout.split('\0').filter(Boolean);
  const hasPlan = paths.includes('bin/cells-plan.json');
  const candidates = paths.filter(path => path.startsWith('src/') && !path.slice(4).includes('/') && ENGINE_CANDIDATE.test(path.slice(4)));
  if (!hasPlan && !candidates.length) return null;
  const scratch = mkdtempSync(join(tmpdir(), 'pullboard-landing-plan-'));
  const tree = join(scratch, 'tree');
  const cleanup = () => {
    spawnSync('git', ['worktree', 'remove', '--force', tree], { cwd: root, env });
    rmSync(scratch, { recursive: true, force: true });
  };
  try {
    const add = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', tree, commit], { cwd: root, env, encoding: 'utf8' });
    if (add.status !== 0) throw new Refused('LAND_PLAN_CHECK', `could not check out ${commit.slice(0, 12)} to run the cells-plan check: ${add.stderr.trim()}; retry merged`);
    const pending = candidates.filter(path => {
      const file = join(tree, path);
      if (!lstatSync(file).isFile()) throw new Refused('LAND_PLAN_CHECK', `engine leaf ${path} must be a regular source file before recording merged`);
      return unnumberedEngine(readFileSync(file, 'utf8'));
    });
    if (pending.length) throw new Refused('LAND_ENGINE_UNNUMBERED', `${commit.slice(0, 12)} leaves unnumbered engines: ${pending.join(', ')}; run amendLandingEngines during landing to assign their numbers, then record the resulting commit`);
  } catch (error) { cleanup(); throw error; }
  return { tree, env, hasPlan, cleanup };
}

/** Refuse a failed plan check, naming its unplaced or stale paths. */
function judgePlanRun(run, commit) {
  if (run.status === 0) return;
  const lines = `${run.stderr}\n${run.stdout}`.split('\n').filter(line => /^(not in bin\/cells-plan\.json:|stale plan row|.*(CELLS_|retired historical))/u.test(line));
  const unplaced = lines.filter(line => line.startsWith('not in bin/cells-plan.json:')).map(line => line.slice(line.indexOf(':') + 1).trim());
  const detail = unplaced.length ? `unplaced paths: ${unplaced.join(', ')}` : (lines.join('; ') || run.stderr.trim().split('\n').pop() || 'the check failed');
  throw new Refused('LAND_PLAN_UNPLACED', `${commit.slice(0, 12)} fails the cells-plan check (${detail}); place each path with node bin/cells-plan.js --place <path> --cell <cell> (or --stay), commit it, and record that commit`);
}
