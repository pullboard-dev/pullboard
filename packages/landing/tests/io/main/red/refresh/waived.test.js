/** A file-level red in a waived file is a waived proof, and an item red three batches in a row returns to its builder [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waivedFileProof } from '../../../../../index.js';
import { LANDING_RED_LIMIT } from '../../../../../index.js';
import { repeatedReds } from '../../../../../index.js';

const FILE = 'apps/cli/journeys/submit/merge.test.js';
const NOW = Date.parse('2026-11-09T08:51:47.000Z');

/** A board stand-in holding the person's file waivers, read as the landing reads them. */
function board(waivers) {
  return { clock: { now: () => new Date(NOW) },
    db: { prepare: () => ({ all: () => waivers.map(waiver => ({ event_by: 'person', event_detail: JSON.stringify({ waiver }) })) }) } };
}

const ports = { quarantineWaivers: () => [] };
const waiver = { id: '2360cc6b-ccc7-4dbc-9754-d9d53751b422', test: FILE, until: '2026-11-09T15:00:00.000Z', reason: 'held while #4041 fixes it', by: 'person' };

/** #3768's 9 Nov candidate gate: the file failed at file level, its failure named by its runner path, and it never completed. */
function gate(extra = {}) {
  return { tree: 't'.repeat(40), isGreen: false, complete: false, logPath: '/logs/candidate-1.log',
    failures: [{ file: FILE, name: `/Users/example/.pullboard-runner/jobs/j/checkout/${FILE}`, assertion: "error: 'test failed'" }],
    collectionReport: { plannedFiles: ['packages/landing/tests/io/reuse/t1.test.js', FILE], completedFiles: ['packages/landing/tests/io/reuse/t1.test.js'] }, ...extra };
}

test('clause 1: a live file waiver covers a file-level red that left its file uncompleted, so the trunk is not held [C7]', () => {
  const proof = waivedFileProof({ board: board([waiver]), landingPorts: ports }, gate());
  assert.ok(proof, 'the waived file is a waived proof');
  assert.deepEqual(proof.failures.map(entry => [entry.file, entry.waiver]), [[FILE, waiver.id]]);
  assert.equal(waivedFileProof({ board: board([]), landingPorts: ports }, gate()), null, 'with no waiver it holds as before');
  assert.equal(waivedFileProof({ board: board([{ ...waiver, until: '2026-11-09T08:00:00.000Z' }]), landingPorts: ports }, gate()), null, 'an expired waiver covers nothing');
  const other = gate({ collectionReport: { plannedFiles: ['test/other.test.js', FILE], completedFiles: [] } });
  assert.equal(waivedFileProof({ board: board([waiver]), landingPorts: ports }, other), null, 'an unwaived file the run never completed keeps the gate incomplete');
  assert.equal(waivedFileProof({ board: board([waiver]), landingPorts: ports }, gate({ collectionReport: undefined })), null, 'no collection report, no waived proof');
});

/** One landing batch record holding #3768 at a commit. */
function batch(id, state, extra = {}) {
  return { id, state, items: [{ id: 3768, commit: 'c1' }], ...extra };
}

test('clause 4: an item red in three batches in a row at one commit leaves selection and returns to its builder [C7]', () => {
  const item = { item_id: 3768, item_commit: 'c1' };
  const red = id => batch(id, 'blocked', { failures: [{ file: FILE, name: FILE }] });
  assert.equal(LANDING_RED_LIMIT, 3);
  assert.equal(repeatedReds([red('a'), batch('b', 'test-defect'), red('c')], item), 3);
  assert.equal(repeatedReds([red('a'), batch('b', 'blocked', { refusal: { code: 'LAND_LEASE_LOST' } }), red('c')], item), 2, 'a fault names no test and is not a red');
  assert.equal(repeatedReds([red('a'), batch('b', 'landed'), red('c')], item), 1, 'a landing ends the run');
  assert.equal(repeatedReds([red('a'), red('b'), red('c')], { item_id: 3768, item_commit: 'c2' }), 0, 'a new commit starts again');
  // Later revisions of one batch count once, at their latest state.
  assert.equal(repeatedReds([batch('a', 'gating'), red('a'), red('b')], item), 2);
});
