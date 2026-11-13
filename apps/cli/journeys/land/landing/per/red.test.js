/** Per-item landing: a red batch isolates its culprit and lands the rest in the same run [C7,#2901,#5815]. */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../../../tests/fixtures/land/project.js';
import {
  json,
} from '../../../../tests/fixtures/land/board.js';
import {
  perItemProject,
  establishBaseFile,
  item,
  land,
} from '../../../../tests/fixtures/land/per.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { landProject, submitItem, acceptItem, moveMainPastSubmit } = makeLandProjectFixtures(e2e);

test('clause 2: a red batch isolates its culprit and lands the rest in the same run [C7,#2901,#5815]', { timeout: 300_000 }, // budget: two real submits, accepts and one bisected landing; hang ceiling only.
async () => {
  const box = perItemProject(landProject);
  establishBaseFile(box, 1, e2e);
  const red = await item(box, 1), green = await item(box, 2);
  box.env.LAND_SUPPRESS_RED = '1';
  // The review's frozen check runs here too, so the red stays suppressed through its accept; the land job does not inherit it [C7].
  try { submitItem(box, red, 'RED\n'); submitItem(box, green); acceptItem(box, red); } finally { delete box.env.LAND_SUPPRESS_RED; }
  acceptItem(box, green);
  moveMainPastSubmit(box); // the red submit was recorded green with its red suppressed; main moves so landing runs its own gate [C7]
  const start = box.git(box.repo, 'rev-parse', 'main');

  const one = await land(box);
  assert.deepEqual(one.landed, [green.item], 'the green item lands in the same run');
  assert.deepEqual(one.returned.map(entry => entry.id), [red.item], 'the bisection names the red item');
  const tip = box.git(box.repo, 'rev-parse', 'main');
  assert.notEqual(tip, start);
  assert.ok(json(box, box.repo, 'show', String(green.item)).item_merged_commit, 'the green item is recorded merged');
  assert.equal(json(box, box.repo, 'show', String(red.item)).item_merged_commit, null, 'nothing red reaches main');
  assert.match(JSON.stringify(json(box, box.repo, 'show', String(red.item))), /land-1\.test\.js/u, 'the red item carries evidence naming the failing file');
});

