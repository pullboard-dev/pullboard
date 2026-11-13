/** Per-item landing: two land runs on an unchanged board never record the same stop twice [C7,#2901]. */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../../../tests/fixtures/land/project.js';
import {
  events,
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

test('two land runs on an unchanged board never record the same stop twice [C7,#2901]', { timeout: 300_000 }, // budget: one real submit, accept and three landings; hang ceiling only.
async () => {
  const box = perItemProject(landProject);
  establishBaseFile(box, 1, e2e);
  const red = await item(box, 1);
  box.env.LAND_SUPPRESS_RED = '1';
  try { submitItem(box, red, 'RED\n'); } finally { delete box.env.LAND_SUPPRESS_RED; }
  acceptItem(box, red);
  moveMainPastSubmit(box);

  await land(box);
  const recorded = events(box);
  const reopens = rows => rows.filter(row => row.item_id === red.item && row.event_kind === 'reopen').length;
  assert.equal(reopens(recorded), 1, 'the stop is recorded once');
  await land(box);
  await land(box);
  const later = events(box);
  assert.equal(reopens(later), 1, 'no second reopen');
  assert.deepEqual(later.slice(recorded.length).map(row => row.event_kind), [], 'the later runs record nothing');
});
