/** Real conflict returns recorded by review selection and landing trains [C7,B3]. */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { causeKit } from '../../../tests/fixtures/reopen/cause.js';
import { fixtureMachineSettings } from '../../../tests/fixtures/testkit.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);
const { FILE, SECOND, json, project, submit, accept, latest, assertConflict } = causeKit(helpers);

test('local and inline landing trains record sibling conflict files [C7,B3]', async () => {
  for (const separate of [true, false]) {
    const box = project(separate);
    // The landing train is this machine's own in-process batch; a pull machine offers a runner land job instead (#6249).
    fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { gate: { runnerDispatch: 'controller' } });
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
