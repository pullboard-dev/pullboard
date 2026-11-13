/** Real conflict returns recorded by review selection and landing trains [C7,B3]. */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { causeKit } from '../../../tests/fixtures/reopen/cause.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);
const { FILE, SECOND, json, project, submit, accept, latest, assertConflict } = causeKit(helpers);

test('local and inline landing trains record sibling conflict files [C7,B3]', async () => {
  for (const separate of [true, false]) {
    const box = project(separate);
    const first = (await submit(box, 1));
    const second = (await submit(box, 2));
    (await accept(box, first));
    (await accept(box, second));
    const landed = (await json(box, box.repo, 'land'));
    assert.deepEqual(landed.landed, [first.id]);
    assert.equal(landed.conflicts.length, 1);
    assert.deepEqual([...landed.conflicts[0].files].sort(), [FILE, SECOND].sort());
    assertConflict(latest(box, second.id), landed.conflicts[0].files);
  }
});
