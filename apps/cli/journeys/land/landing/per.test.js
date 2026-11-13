/** Per-item landing, the default: one batch takes every clean verified item [C7,#2901,#5815]. */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../../tests/fixtures/land/project.js';
import {
  json,
} from '../../../tests/fixtures/land/board.js';
import {
  perItemProject,
  item,
  refuseEveryCommit,
  land,
} from '../../../tests/fixtures/land/per.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { landProject, submitItem, acceptItem } = makeLandProjectFixtures(e2e);

test('clause 1: one landing batch lands all three verified items that merge cleanly, hooks off, each recorded merged [C7,#2901,#5815]', { timeout: 300_000 }, // budget: three real submits, accepts and one landing; hang ceiling only.
async () => {
  const box = perItemProject(landProject);
  const first = await item(box, 1), second = await item(box, 2), third = await item(box, 3);
  for (const entry of [first, second, third]) submitItem(box, entry);
  acceptItem(box, second); // accepted first, so it merges first
  acceptItem(box, first);
  acceptItem(box, third);
  refuseEveryCommit(box);
  const start = box.git(box.repo, 'rev-parse', 'main');

  const one = await land(box);
  assert.deepEqual(one.landed, [second.item, first.item, third.item], 'one run lands every clean item in accept order');
  assert.equal(one.batch.items.length, 3, 'all three ride one batch');
  const tip = box.git(box.repo, 'rev-parse', 'main');
  assert.notEqual(tip, start, 'main fast-forwarded to the batch');
  for (const entry of [first, second, third]) {
    const merged = json(box, box.repo, 'show', String(entry.item)).item_merged_commit;
    assert.ok(merged, `#${entry.item} is recorded merged`);
    assert.equal(box.git(box.repo, 'merge-base', '--is-ancestor', entry.commit, tip), '', `#${entry.item}'s reviewed commit is on main`);
  }
  assert.equal(box.git(box.repo, 'ls-remote', 'origin', 'main').split(/\s+/u)[0], tip, 'the published main is the landed tip');
});

