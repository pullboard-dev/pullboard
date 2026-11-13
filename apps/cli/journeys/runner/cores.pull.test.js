/** A pulled gate's proof runs with every core of the runner that holds the job, since that runner is the whole job's execution host [P7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { availableParallelism } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { boardJobQueueCall } from '../../../../packages/api/index.js';
import { jobsOf } from '../../../../packages/jobs/index.js';
import { pullProject } from '../../tests/fixtures/pull.js';
import { pullQueue } from '../../tests/fixtures/pull.js';
import { serveOnce } from '../../tests/fixtures/pull.js';
import { submitOne } from '../../tests/fixtures/pull.js';

const REPO = resolve(import.meta.dirname, '../../../..');

/** The stand-in proof asks the real test runner's concurrency policy how many files it would run at once in its job. */
const PROOF = `import { appendFileSync } from 'node:fs';
import { record } from './record.js';
import { testConcurrency } from ${JSON.stringify(pathToFileURL(join(REPO, 'packages/gate/src/io/test/concurrency.js')).href)};
record(process.cwd(), 'proof');
appendFileSync(process.env.PULLBOARD_FIXTURE_STEPS, JSON.stringify({ step: 'proof-cores', files: testConcurrency(process.cwd()).files, marker: process.env.PULLBOARD_PULLED_JOB ?? null }) + '\\n');
`;

test('clause 1: inside a pulled gate job the proof runs its files with the runner\'s core count, not the performance cores of a shared slot [P7]', { timeout: 180_000 }, // budget: hang ceiling for a project, one submit and one whole gate in a runner process.
async t => {
  const box = await pullProject(t, 1, { tooling: { 'bin/proof.js': PROOF } });
  const [id] = box.ids;
  submitOne(box, id);
  const { board, url } = await pullQueue(t, box, { queue: (current, body) => boardJobQueueCall(current, body, { mode: 'pull', trunk: () => box.repo }) });
  const steps = join(box.runnerHome, 'steps.jsonl');
  const served = await serveOnce(box, url, 'r-cores', { PULLBOARD_FIXTURE_STEPS: steps });
  assert.equal(served.code, 0, served.output);

  const [row] = jobsOf(board.db, { kind: 'gate', item: id });
  const { receipt } = row.steps.find(step => step.name === 'receipt').payload;
  assert.equal(receipt.gate.green, true, JSON.stringify(receipt.gate).slice(0, 6000));
  const cores = readFileSync(steps, 'utf8').trim().split('\n').map(line => JSON.parse(line)).find(entry => entry.step === 'proof-cores');
  assert.ok(cores, 'the proof recorded its concurrency');
  assert.equal(cores.marker, '1', 'the gate job marks its proof as the runner job');
  assert.equal(cores.files, availableParallelism(), 'the proof spreads its files over every core of the runner');
});
