/** A pulled submit leaves exactly one gate job row for the item, whatever the fixture's local runner does after [C7,V4,#6489]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { jobsOf } from '../../../../../packages/jobs/index.js';
import { document } from '../../fixtures/submit/handoff.js';
import { fixture } from '../../fixtures/submit/handoff.js';
import { withBoardFile } from '../../fixtures/submit/handoff.js';
import { settledGateJob } from '../../fixtures/submit/settle.js';

/** The item's gate job rows, oldest first, read from the fixture's board file. */
function gateRows(box) {
  return withBoardFile(box, db => jobsOf(db, { kind: 'gate', item: box.id }));
}

test('cli.journeys-submit-one-gate-row.a-submit-leaves-exactly-one-gate: clause 1: a submit leaves exactly one gate job row for the item, through the pull path [C7,V4,#6489]', async t => {
  const box = fixture(t);
  // The submit must not wait for the held gate to settle, or it would never return before the release file is written.
  box.env.PULLBOARD_FIXTURE_UNSETTLED = '1';
  // The gate holds on its release file, so the count is read while the one job is still the item's whole gate history.
  assert.equal(gateRows(box).length, 0, 'no gate job exists before the submit');
  const queued = document(await box.runLocal(box.web, 'submit', String(box.id), '--no-next', '--json'));
  assert.equal(queued.queued, true, 'the submit went through the pull path: it queued a job and ran no gate itself');
  const held = gateRows(box);
  assert.equal(held.length, 1, 'one submit queues exactly one gate job row');
  assert.equal(held[0].id, queued.gateJob, 'the row is the job the acknowledgment names');
  writeFileSync(box.release, 'release\n');
  await settledGateJob(box, box.id);
  const settled = gateRows(box);
  assert.equal(settled.length, 1, 'the gate finishing adds no second row');
  assert.equal(settled[0].id, queued.gateJob, 'the same row finished');
});
