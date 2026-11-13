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
    // A pull machine's land returns queued; the settled landing's outcome is the board's record of it [P7,C7].
    await json(box, box.repo, 'land');
    assert.equal((await json(box, box.repo, 'show', String(first.id))).item_status, 'landed');
    const record = latest(box, second.id);
    assert.deepEqual([...record.detail.conflict.files].sort(), [FILE, SECOND].sort());
    assertConflict(record, [FILE, SECOND]);
  }
});
