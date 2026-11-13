/** Shared real Git fixture for cells plan placement and metadata contracts [C7,D3]. */
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import {
  runFixtureGit,
  privateFixtureFiles,
} from '../../../gate/tests/fixtures/child.js';
import { warmAcceptedCells } from '../../../gate/index.js';
import { withMainCheckout } from '../../index.js';
import { withFileLock } from '../../../outbox/index.js';
import assert from 'node:assert/strict';

/** Git for this checkout or a fixture, never steered by a caller's GIT_* variables. */
export function git(cwd, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return runFixtureGit(args, { cwd, encoding: 'utf8', env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Cells plan fixture', GIT_AUTHOR_EMAIL: 'cells@example.invalid', GIT_COMMITTER_NAME: 'Cells plan fixture', GIT_COMMITTER_EMAIL: 'cells@example.invalid' } });
}

/** Build a small real repository: three packages in a chain, a two-cell cycle and one module newer than the seed. */
export function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-cells-plan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  /** Write one file beneath the fixture. */
  const put = (file, source) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), source); };
  put('package.json', JSON.stringify({ type: 'module' }));
  put('src/refused.js', 'export class Refused extends Error {}\n');
  put('src/board.js', "import { Refused } from './refused.js';\nimport { claims } from './claims.js';\nexport const board = () => [Refused, claims];\n");
  put('src/claims.js', "import { board } from './board.js';\nexport const claims = () => board;\n");
  put('src/stats.js', "import { board } from './board.js';\nimport { readFileSync } from 'node:fs';\nexport const stats = () => [board, readFileSync];\n");
  put('src/stats-flow.js', "import { stats } from './stats.js';\nexport const flow = () => stats;\n");
  put('src/cli.js', "import { stats } from './stats.js';\nimport { flow } from './stats-flow.js';\nconsole.log(stats, flow);\n");
  put('bin/tool.js', "import '../src/cli.js';\n");
  put('packages/codemap/data/plan/seed.json', JSON.stringify({ source: 'fixture', sha256: 'none', order: ['kernel', 'store', 'items', 'stats', 'app:cli'],
    cells: { kernel: ['src/refused.js'], store: ['src/board.js'], items: ['src/claims.js'], stats: ['src/stats.js'], 'app:cli': ['src/cli.js'] }, tests: {} }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'fixture');
  return { root, put };
}


/** Trusted fixture controller authority: all original plan cells have accepted cut items on the pinned main. */
export function acceptedCutItems(root, main) {
  const plan = JSON.parse(git(root, 'show', `${main}:packages/codemap/data/plan/cells.json`));
  return plan.cells.map((cell, index) => ({ item_id: index + 1, item_lane: 'core',
    item_title: `Cells import cuts: ${cell.name} removes imports into later cells`,
    item_status: 'verified', item_merged_commit: main }));
}

/** Publish the background producer's accepted inventory for the fixture's immutable main. */
export async function publishAcceptedCells(t, root, main, machineHome) {
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  const machine = machineHome ?? privateFixtureFiles('cells-fixture-machine-').root;
  if (!machineHome) t.after(() => rmSync(machine, { recursive: true, force: true }));
  process.env.PULLBOARD_MACHINE_HOME = machine;
  try {
    const artifact = await warmAcceptedCells(root, main, { withCheckout: withMainCheckout, withLock: withFileLock, trunk: 'main' });
    assert.equal(artifact.available, true, 'the producer published the accepted inventory');
    return artifact;
  } finally {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previous;
  }
}
