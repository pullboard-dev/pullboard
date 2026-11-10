/** Numbered engine history is data under packages/state/data/history, never placed through the cells plan [C7,D3,H16]. */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cleanGitEnvironment } from '../../../git/index.js';
import { git } from '../../../git/index.js';
import { Refused } from '../../../kernel/index.js';

/**
 * Skip generated engine histories: they are data, so the cells plan never places them [C7,D3,H16].
 * Why: the plan's scope covers source (src/, relay/, bin/), not packages/state/data, so `plan.js --place` refused every
 * generated history with CELLS_UNPLACED and failed the landing. The scope stays narrow; `plan.js --check` already
 * ignores history snapshots by rule, so skipping leaves cells-plan green.
 * @returns {string[]} Always empty: no plan file changes for a data path. The `place` seam is kept so a caller can prove it is never used.
 */
export function placeLandingHistory(root, files, { place = placeWithPlan } = {}) {
  void root; void files; void place;
  return [];
}

/** The canonical placement command, run in the landing worktree with a clean Git environment. */
function placeWithPlan(root, file) {
  return runPlan(root, ['--place', file, '--stay']);
}

/** The plan command in a landing worktree, with a clean Git environment. */
function runPlan(root, args) {
  return spawnSync(process.execPath, ['packages/codemap/src/io/cells/scripts/plan.js', ...args], {
    cwd: root, env: cleanGitEnvironment(), encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024,
  });
}

/**
 * Name the files the committed cells plan does not cover, as `cells-plan --check` reports them [C7].
 * @param {string} root A worktree with a cells plan.
 * @param {(root: string, args: string[]) => { status: number | null, stdout?: string, stderr?: string }} run The plan command.
 * @returns {string[]} The unplaced paths; engines and move history are placed by the plan's own rules and never appear.
 */
function unplacedPaths(root, run) {
  const checked = run(root, ['--check']);
  if (checked.status === 0) return [];
  const names = `${checked.stderr ?? ''}\n${checked.stdout ?? ''}`.split('\n')
    .map(line => /^not in packages\/codemap\/data\/plan\/cells\.json: (\S+)$/u.exec(line)?.[1]).filter(Boolean);
  return [...new Set(names)];
}

/**
 * Place every file the committed cells plan does not cover as a stay, so a landing never leaves `cells-plan --check` red [C7].
 * Why: three landings on 7 Nov (packages/gate/src/io/check/cla.js, packages/gate/src/io/edges.js, packages/gate/src/io/sync/spawn.js) went red until a
 * person ran `cells-plan.js --place <path> --stay` and committed it. Production call sites: amendLandingEngines (the automatic
 * lander, in the item's own merge) and placeUncoveredOnTrunk in the merged command (a hand landing).
 * @param {string} root A landing worktree whose new files are tracked.
 * @param {{ run?: (root: string, args: string[]) => { status: number | null, stdout?: string, stderr?: string } }} [options] A test seam for the plan command.
 * @returns {string[]} The plan files that changed, ready to stage; empty when the plan already covered everything.
 */
export function placeLandingNewFiles(root, { run = runPlan } = {}) {
  if (!existsSync(join(root, 'packages/codemap/data/plan/cells.json'))) return [];
  const unplaced = unplacedPaths(root, run);
  for (const file of unplaced) {
    const result = run(root, ['--place', file, '--stay']);
    if (result.status !== 0) {
      const detail = String(result.stderr ?? '').split('\n').find(line => /\[[A-Z_]+\]/u.test(line)) ?? '';
      throw new Refused('LAND_MERGE', `cells plan rule placement failed for ${file}${detail ? `: ${detail.trim()}` : ''}; repair the cells plan and retry landing`);
    }
  }
  if (!unplaced.length) return [];
  return git(root, ['diff', '--name-only', 'HEAD', '--', 'packages/codemap/data/plan/']).split('\n').filter(Boolean);
}
