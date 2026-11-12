/** An item whose gate job no runner works reads "(in the gate, no runner)" in list, show and status, with the way out [C7,#6554]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import {
  fixtureAdd,
  withFixtureBoard,
} from '../../tests/fixtures/testkit.js';
import {
  createJob,
  writeStep,
} from '../../../../packages/jobs/index.js';

const NEXT = 'next: pullboard runner local, or pullboard submit';

/** A fixture project with one claimed item whose pulled gate job was offered `ageMs` ago and has no runner. */
async function gated(t, ageMs) {
  const helpers = createE2eHelpers();
  let box;
  try { box = helpers.project('true', helpers.sandbox()); }
  catch (error) { helpers.cleanup(); throw error; }
  t.after(() => helpers.cleanup());
  const added = fixtureAdd(box.run, box.repo, 'web', 'Waits for a runner', '--specs', 'G1', '--criterion', 'Done.', '--check', 'true', '--json');
  assert.equal(added.code, 0, `${added.err}\n${added.out}`);
  const id = JSON.parse(added.out).item.item_id;
  assert.equal((await box.runLocal(box.web, 'claim', String(id), '--json')).code, 0);
  const at = Date.now() - ageMs;
  // @pullboard-board-file journey: leave an offered gate job no runner took, as a killed local runner does.
  withFixtureBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), board => {
    createJob(board.db, { id: `gate:${id}:norunner`, kind: 'gate', item: id, candidate: 'c'.repeat(40), now: at });
    writeStep(board.db, `gate:${id}:norunner`, 'offered', {}, { now: at });
  });
  return { box, id };
}

test('clause 1: list, show and status read an offered gate job idle over 30 s as "(in the gate, no runner)" with the next line [C7,#6554]', async t => {
  const { box, id } = await gated(t, 120_000);
  const list = await box.runLocal(box.web, 'list');
  assert.match(list.out, new RegExp(`#${id}\\b.*\\(in the gate, no runner\\)`), list.out + list.err);
  const show = await box.runLocal(box.web, 'show', String(id));
  assert.match(show.out, /\(in the gate, no runner\)/, show.out + show.err);
  assert.ok(show.out.includes(`${NEXT} ${id} again`), show.out);
  const status = await box.runLocal(box.web, 'status');
  assert.ok(status.out.includes(`top blocker: #${id} (in the gate, no runner)`), status.out + status.err);
});

test('clause 1: a gate job offered a moment ago still reads "(in the gate)" with no runner warning [C7,#6554]', async t => {
  const { box, id } = await gated(t, 1_000);
  const list = await box.runLocal(box.web, 'list');
  assert.match(list.out, new RegExp(`#${id}\\b.*\\(in the gate\\)`), list.out);
  assert.doesNotMatch(list.out, /no runner/);
  const status = await box.runLocal(box.web, 'status');
  assert.doesNotMatch(status.out, /top blocker/);
});
