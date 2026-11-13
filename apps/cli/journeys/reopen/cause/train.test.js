/** Real conflict returns recorded by review selection and landing trains [C7,B3]. */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { settleLand } from '../../../tests/fixtures/land/settle.js';
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
    // A pull machine's land returns queued; the land job's receipt is the settled landing [P7,C7].
    const landed = await settleLand(box, await json(box, box.repo, 'land'));
    // The pulled lander picks the train order: one sibling lands and the other returns with its conflict files.
    assert.equal(landed.landed.length, 1, JSON.stringify(landed.landJob));
    assert.deepEqual(landed.returned.map(row => row.reason), ['conflict'], JSON.stringify(landed.landJob));
    const record = latest(box, landed.returned[0].id);
    assert.deepEqual([...record.detail.conflict.files].sort(), [FILE, SECOND].sort());
    assertConflict(record, [FILE, SECOND]);
  }
});
