/** @pullboard-test-input packages/drive/src/io/queue.js */
/** @pullboard-world-pin: a run whose runner receipt is posted reads "still recording" while its worker holds a live lease, and "stopped" once the lease lapsed [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TEST_RUN_KIND } from '../../index.js';
import { testRunState } from '../../index.js';
import { testRunLines } from '../../index.js';

const now = 1_000_000_000;
const pulled = { job: 'job-1', runner: 'host-1', receipt: { status: 0, durationMs: 4000, gate: { green: true, phases: [{ status: 0, failures: [] }] } } };

/** A test-run job view with the given lease. */
function view(leaseOwner, leaseUntil) {
  return { id: 'run-1', kind: TEST_RUN_KIND, item: null, created: now - 60_000, leaseOwner, leaseUntil,
    steps: [{ name: 'queued', payload: { files: ['a.test.js'], log: null, agent: 'seat' } }] };
}

test('drive.recording.a-posted-receipt-with-a: clause 1: a posted receipt with a live worker lease reads as being recorded, not stopped [C7]', () => {
  const run = testRunState(view('test-run:1', now + 60_000), now, { pulled });
  assert.equal(run.status, 'green');
  assert.match(run.result.notices[0], /the worker is still recording it/u);
  assert.doesNotMatch(run.result.notices[0], /stopped/u);
});

test('drive.recording.a-posted-receipt-whose-worker: clause 2: a posted receipt whose worker lease lapsed still reads the stopped-worker notice [C7]', () => {
  for (const lapsed of [view('test-run:1', now - 1000), view(null, 0)]) {
    const run = testRunState(lapsed, now, { pulled });
    assert.match(run.result.notices[0], /the worker stopped before recording it/u);
  }
});

/** A red receipt from a pulled run: the phase lists the given failures and the gate the given verdicts. */
const redPulled = (failures, verdicts) => ({ job: 'job-2', runner: 'host-1',
  receipt: { status: 1, durationMs: 4000, gate: { green: false, verdicts, phases: [{ status: 1, failures }] } } });

test('drive.recording.red-receipt-names-verdict-files: clause 1: a red receipt whose phase lists no failures names each verdict file with its first case in a failing line [C7,#10678]', () => {
  const run = testRunState(view('test-run:1', now + 60_000), now,
    { pulled: redPulled(null, { 'apps/x/tests/a.test.js': ['clause 1: a case [C7]'], 'apps/x/tests/b.test.js': ['/runner/work/apps/x/tests/b.test.js'] }) });
  assert.equal(run.status, 'red');
  assert.deepEqual(run.result.failures, []);
  assert.deepEqual(run.result.notices.slice(1), ['failing (from the receipt): apps/x/tests/a.test.js: clause 1: a case [C7]', 'failing (from the receipt): apps/x/tests/b.test.js']);
  assert.ok(testRunLines(run).includes('  failing (from the receipt): apps/x/tests/a.test.js: clause 1: a case [C7]'));
});

test('drive.recording.green-or-listed-receipt-adds-none: clause 2: a green receipt, or a red one whose phase lists failures, adds no verdict line and keeps its failures [C7,#10678]', () => {
  const green = testRunState(view('test-run:1', now + 60_000), now, { pulled });
  assert.equal(green.result.notices.length, 1);
  const listed = [{ file: 'apps/x/tests/a.test.js', name: 'clause 1: a case', error: 'test failed' }];
  const red = testRunState(view('test-run:1', now + 60_000), now, { pulled: redPulled(listed, { 'apps/x/tests/a.test.js': ['clause 1: a case'] }) });
  assert.deepEqual(red.result.failures, listed);
  assert.equal(red.result.notices.length, 1);
});
