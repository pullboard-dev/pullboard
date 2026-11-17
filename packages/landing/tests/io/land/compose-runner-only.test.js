/** @pullboard-test-input packages/landing/src/io/step/merge.js */
/** @pullboard-test-input packages/landing/src/io/step/compose.js */
/** With landing.runnerOnlyCompose on, a batch the runner cannot compose is refused and nothing merges on the coordinator; off, the fallback stays [C7,#10246]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runFixtureGit } from '../../../../gate/tests/fixtures/child.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../gate/tests/fixtures/testkit.js';
import { cellRepo } from '../../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../../store/tests/fixtures/cell.js';
import { openCellBoard } from '../../../../store/tests/fixtures/cell.js';
import * as store from '../../../../store/index.js';
import { loadConfig } from '../../../../config/index.js';
import { mergeGroup } from '../../../src/io/step/merge.js';

const git = (root, ...args) => runFixtureGit(args, { cwd: root }).trim();

/** Run mergeGroup on a named batch whose runner answers nothing (composeOnRunner returns null); returns the outcome and what main looks like. */
async function landWithDeadRunner(t, settings) {
  const repo = cellRepo(t, { real: true });
  const { root: dir } = privateFixtureFiles('pullboard-compose-runner-only-');
  const board = openCellBoard(join(dir, 'board.sqlite'));
  t.after(() => { store.closeBoard(board); rmSync(dir, { recursive: true, force: true }); });
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
  t.after(() => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; });
  const identity = { GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.com', GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.com' };
  const before = Object.fromEntries(Object.keys(identity).map(key => [key, process.env[key]]));
  Object.assign(process.env, identity);
  t.after(() => { for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const root = repo.root;
  const base = repo.commit;
  repo.put('web/page.txt', 'page\n');
  const tip = repo.commitAll();
  git(root, 'checkout', '-q', '--detach', base);
  // The scan and derive scripts make the batch ride a runner; their content never runs here.
  repo.put('packages/landing/src/io/scan.js', '// scan\n');
  repo.put('packages/landing/src/io/derive.js', '// derive\n');
  const trunk = repo.commitAll();
  const item = cellItem(board, { lane: 'web', title: 'Add the page', specIds: ['G1'] });
  const said = [];
  const state = {
    board, config: { ...loadConfig(root), staticChecks: 'true' }, say: line => said.push(line), onWait() {}, checkLease: async () => {},
    guardServices: { runStaticChecks: async () => ({ output: '' }) },
    landingPorts: { badgeCounts: () => ({}), writeBadges: () => [] },
    write: async (_name, [{ batch }]) => batch,
    batch: { id: 'b1', root, base: trunk, external: true, candidates: [{ id: item.item_id, commit: tip }], items: [], conflicts: [], resolutions: [] },
  };
  const outcome = await mergeGroup(state, [{ id: item.item_id, commit: tip }]).then(result => ({ result }), error => ({ error }));
  return { ...outcome, said, root, trunk, tip, head: git(root, 'rev-parse', 'HEAD') };
}

test('landing.compose-runner-only.runner-compose-failure-refuses-with-the-setting-on: clause 1: with landing.runnerOnlyCompose on and composeOnRunner returning null, mergeGroup refuses LAND_RUNNER_REQUIRED naming the next step and merges nothing [C7,#10246]', async t => {
  const landed = await landWithDeadRunner(t, { landing: { runnerOnlyCompose: true } });
  assert.equal(landed.error?.code, 'LAND_RUNNER_REQUIRED');
  assert.match(landed.error.message, /runner could not compose/u);
  assert.match(landed.error.message, /fix the runner/u, 'the refusal names the next step');
  assert.equal(landed.head, landed.trunk, 'no merge or commit moved the batch root');
  assert.equal(git(landed.root, 'rev-list', '--count', `${landed.trunk}..HEAD`), '0');
  assert.deepEqual(landed.said, []);
});

test('landing.compose-runner-only.the-setting-off-keeps-the-coordinator-fallback: clause 2: with the setting off, the fallback still merges on the coordinator and says the runner could not compose this batch [C7,#10246]', async t => {
  const landed = await landWithDeadRunner(t, {});
  assert.equal(landed.error, undefined);
  assert.ok(landed.said.includes('the runner could not compose this batch; its items were merged on the coordinator'));
  assert.notEqual(landed.head, landed.trunk, 'the item merged here');
  assert.ok(git(landed.root, 'ls-tree', '-r', '--name-only', 'HEAD').includes('web/page.txt'));
});
