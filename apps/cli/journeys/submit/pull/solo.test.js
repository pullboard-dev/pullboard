/** One pulled gate runs authorization, doctrine, static checks, selection and tests inside its one runner job and posts one receipt [P7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { jobsOf } from '../../../../../packages/jobs/index.js';
import { loopbackRunner } from '../../../tests/fixtures/pull.js';
import { pullProject } from '../../../tests/fixtures/pull.js';
import { submitOne } from '../../../tests/fixtures/pull.js';

test('clause 2: authorization, doctrine, static checks, selection and tests all run inside the one runner job and post one receipt [P7]', async t => {
  const box = await pullProject(t, 1);
  const [id] = box.ids;
  const { commit } = submitOne(box, id, undefined, { compose: true });
  const runner = await loopbackRunner(t, box);
  const job = await runner.take('runner-solo');
  assert.equal(job.input.candidate, commit);
  assert.equal(job.input.request.run.every(arg => typeof arg === 'string' && Buffer.byteLength(arg) <= 4096), true, 'the run is a short argv');
  assert.equal(await runner.take('runner-rival'), null, 'a second runner gets nothing while the lease lives');
  const result = await runner.run(job);
  const steps = readFileSync(join(job.folder, '.git', 'gate-steps.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const names = new Set(steps.map(step => step.step));
  for (const part of ['authorization', 'doctrine', 'static', 'composition', 'cells', 'selection', 'admission', 'proof']) assert.ok(names.has(part), `${part} ran in the runner job`);
  assert.ok(steps.every(step => step.job === job.held.job && step.pid !== process.pid), 'every part ran in the job\'s own process tree, none on the submitting host');
  assert.equal(existsSync(join(box.web, '.git', 'gate-steps.jsonl')), false);
  assert.equal(result.gate.green, true, JSON.stringify(result.gate));
  assert.deepEqual([result.gate.main, result.gate.source], [box.git(box.repo, 'rev-parse', 'main'), commit]);
  assert.deepEqual(result.gate.phases.map(phase => [phase.role, phase.status]), [['check', 0], ['proof', 0]]);
  assert.equal(result.gate.analysis.doctrine, 1);
  const [row] = jobsOf(runner.board.db, { kind: 'gate', item: id });
  assert.equal(row.step, 'done');
  const receipts = row.steps.filter(step => step.name === 'receipt');
  assert.equal(receipts.length, 1, 'one receipt');
  assert.equal(receipts[0].payload.receipt.gate.green, true);
});
