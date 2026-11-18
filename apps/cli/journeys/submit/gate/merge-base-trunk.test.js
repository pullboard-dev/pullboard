/** @pullboard-test-input source-cell apps/cli */
/**
 * Claim-head reads, trunk merge-base reads and branch changes made before the claim: one slice of the submit gate proof, split from gate.test.js to stay under the runner time budget [V4,C7,V16].
 */
import assert from 'node:assert/strict';
import { selectAffectedTests } from '../../../../../packages/gate/index.js';
import { coordinatorLocal } from './local.js';
import { runLocal } from './local.js';
import { submitSettled } from './local.js';
import { privateRepo } from '../../../tests/fixtures/submit/gate.js';
import { builderRepo } from '../../../tests/fixtures/submit/gate.js';
import { put } from '../../../tests/fixtures/submit/gate.js';
import { commitAll } from '../../../tests/fixtures/submit/gate.js';
import { seedGraph } from '../../../tests/fixtures/submit/gate.js';
import { test } from 'node:test';

test('cli.journeys-submit-gate-merge-base-trunk.affected-selection-reads-old-edges-and: affected selection reads old edges and all changes at the trunk merge base [V4,C7]', async (t) => {
  const box = privateRepo(t);
  const trunk = seedGraph(box);
  box.git('rm', 'src/a.js');
  const claim = commitAll(box, 'refactor(core): remove old source [G1]');
  // A claim made after the deletion and an empty receipt must not hide the trunk-relative change.
  const selection = selectAffectedTests(box.root, { base: claim, trunk, changed: [] });
  assert.equal(selection.full, false);
  assert.deepEqual(selection.files, ['test/a.test.js']);
});

test('cli.journeys-submit-gate-merge-base-trunk.affected-submit-includes-branch-changes-made: affected submit includes branch changes made before the item claim [V4,C7,V16]', async (t) => {
  let box = privateRepo(t);
  put(box.root, 'pullboard.json', JSON.stringify({ gate: 'node --test', affectedTests: 'node --test' }));
  seedGraph(box);
  put(box.root, 'test/a.test.js', "import assert from 'node:assert/strict'; import { value } from '../src/middle.js'; assert.equal(value, 1);\n");
  box = builderRepo(box);
  put(box.root, 'src/a.js', 'export const value = 2;\n');
  commitAll(box, 'feat(core): source before claim [G1]');
  assert.equal((await coordinatorLocal(box, 'add', 'build', 'Existing source change', '--check', 'true')).code, 0);
  assert.equal((await runLocal(box, 'claim', '1')).code, 0);
  put(box.root, 'src/other.js', 'export const other = false;\n');
  commitAll(box, 'feat(core): source after claim [G1]');
  const refused = await submitSettled(t, box, (...args) => runLocal(box, ...args));
  assert.equal(refused.code, 1, refused.out || refused.err);
  assert.equal(refused.receipt.gate.green, false, 'the pulled gate came back red');
  assert.match(refused.err, /test\/a\.test\.js/u, 'the red names the affected importer');
  assert.match(JSON.stringify(refused.gateJob), /ERR_ASSERTION/u);
});
