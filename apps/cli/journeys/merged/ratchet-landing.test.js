/** Quarantine counts are a per-landing ratchet, with named flake evidence [C7,T12]. */
import { settleLand } from '../../tests/fixtures/land/settle.js';
import { join } from 'node:path';
import { openBoard } from '../../../lib/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureSettledMachine } from '../../../../packages/gate/tests/fixtures/testkit.js';
import { makeLandProjectFixtures } from '../../tests/fixtures/land/project.js';
import { closeBoard } from '../../../../packages/store/index.js';
import { logEvent } from '../../../../packages/store/index.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('cli.journeys-merged-ratchet-landing.a-real-landing-no-longer-refuses: a real landing no longer refuses a newly observed unquarantined flake: reds never hold the trunk [C7,T12]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const fixtures = makeLandProjectFixtures(helpers);
  const box = fixtures.landProject();
  // The commit (with test.inProcessHooks on), submit and accept run in this process, not as a node start-up each [C7,#10471].
  fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME, { test: { inProcessHooks: true } });
  const item = await fixtures.itemWorktreeLocal(box, 1);
  await fixtures.commitItemLocal(box, item);
  await fixtures.submitItemLocal(box, item);
  await fixtures.acceptItemLocal(box, item);
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test seeds or reads that same file.
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), undefined, { gitRoot: box.repo });
  try {
    const outcome = passed => [{ file: 'test/unstable.test.js', name: 'unstable case', passed, skipped: false }];
    for (const [id, passed] of [['red-fixture', false], ['green-fixture', true]]) {
      logEvent(board, 'coordinator', 'gate-run', null, { run: { id, version: 1, tree: 'fixture-tree', kind: 'landing', testOutcomes: outcome(passed) } });
    }
  } finally { closeBoard(board); }
  const before = box.git(box.repo, 'rev-parse', 'main');
  const offered = await box.runLocal(box.repo, 'land', '--json');
  assert.equal(offered.code, 0, offered.err + offered.out);
  // lander-v2 L1 (#6813): the pulled land job never holds the trunk for a flake; the open-quarantine count is a health ratchet, so the landing lands.
  const result = await settleLand(box, JSON.parse(offered.out));
  assert.equal(result.batch.state, 'landed', JSON.stringify(result.landJob.receipt));
  assert.notEqual(box.git(box.repo, 'rev-parse', 'main'), before);
});
