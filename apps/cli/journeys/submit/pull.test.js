/** Under gate.runnerDispatch pull a submit writes one gate job row and returns; a runner pulls the whole gate and posts one receipt [P7]; the single-job case is pull/solo.test.js. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getItem } from '../../../../packages/store/index.js';
import { submitHandoff } from '../../../../packages/store/index.js';
import { jobsOf } from '../../../../packages/jobs/index.js';
import { hostProcesses } from '../../tests/fixtures/pull.js';
import { pullProject } from '../../tests/fixtures/pull.js';
import { loopbackRunner } from '../../tests/fixtures/pull.js';
import { submitAll } from '../../tests/fixtures/pull.js';

test('clauses 1 and 3: ten pull submits each write one gate job row and return; the host process count stays flat while the ten gates run [P7]', async t => {
  const box = await pullProject(t, 10);
  const before = hostProcesses(box.dir);
  const submitted = await submitAll(box, box.ids);
  assert.equal(hostProcesses(box.dir), before, 'the ten submits left no process behind on the submitting host');
  for (const { document } of submitted) assert.equal(document.queued, true);
  const runner = await loopbackRunner(t, box);
  const rows = jobsOf(runner.board.db, { kind: 'gate' }).sort((a, b) => a.item - b.item); // the ten submits ran at once, so rows arrive in any order
  assert.deepEqual(rows.map(row => [row.item, row.step]), box.ids.map(id => [id, 'offered']), 'one offered gate job row per submit');
  assert.deepEqual(rows.map(row => row.candidate), submitted.map(entry => entry.commit));
  assert.equal(runner.board.db.prepare("SELECT COUNT(*) AS n FROM job WHERE job_kind <> 'gate'").get().n, 0, 'no dispatcher, driver or worker job exists');
  for (const id of box.ids) {
    assert.equal(submitHandoff(runner.board, id), null, 'no queued hand-off worker');
    assert.equal(getItem(runner.board, id).item_status, 'claimed', 'the builder holds the item until the receipt is recorded');
  }

  const taken = [];
  for (let n = 0; n < box.ids.length; n++) taken.push(await runner.take(`runner-${n}`));
  const samples = [];
  let runnerSeen = 0;
  const sample = () => { samples.push(hostProcesses(box.dir)); runnerSeen = Math.max(runnerSeen, hostProcesses(box.runnerHome)); };
  // Sampled on each event the running jobs emit, so every sample falls while gates are running.
  const finished = await Promise.all(taken.map(job => runner.run(job, sample)));
  assert.ok(runnerSeen > 0, 'the sampler saw the runner jobs running, so it was measuring live');
  assert.ok(samples.length >= 3);
  assert.deepEqual([...new Set(samples)], [before], `the submitting host's process count stayed at ${before} while ten gates ran`);
  assert.deepEqual(finished.map(job => job.status), finished.map(() => 0), JSON.stringify(finished.map(job => job.gate)));
  assert.equal(jobsOf(runner.board.db, { kind: 'gate' }).filter(row => row.step === 'done').length, 10);
});
