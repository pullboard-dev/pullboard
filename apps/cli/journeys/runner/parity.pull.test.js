/** A pulled gate runs its proof as the controller does: as written inside the checkout, with pullboard.trunk set and a per-job environment [P7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardJobQueueCall } from '../../../../packages/api/index.js';
import { jobsOf } from '../../../../packages/jobs/index.js';
import { pullProject } from '../../tests/fixtures/pull.js';
import { pullQueue } from '../../tests/fixtures/pull.js';
import { serveOnce } from '../../tests/fixtures/pull.js';
import { submitOne } from '../../tests/fixtures/pull.js';
import { TOOLING } from '../../tests/fixtures/pull.js';

/** Main's stand-in selection, naming web/run.js as the proof runner, a file the web lane may change. */
const GATE = TOOLING['packages/gate/index.js'].replace("proofCommand: 'node bin/proof.js ./web'", "proofCommand: 'node web/run.js ./web'");

/** Main's proof runner: it records where it runs from, the trunk its checkout names and the environment it was given. */
const RUN = `import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const trunk = execFileSync('git', ['config', 'pullboard.trunk'], { encoding: 'utf8' }).trim();
appendFileSync(process.env.PULLBOARD_FIXTURE_STEPS, JSON.stringify({ step: 'proof-env', script: fileURLToPath(import.meta.url), cwd: process.cwd(), trunk,
  home: process.env.HOME ?? null, tmp: process.env.TMPDIR ?? null, job: process.env.PULLBOARD_RUNNER_JOB ?? null }) + '\\n');
`;

/** A pull project whose proof runs web/run.js, its queue on loopback, and the one item's id. */
async function parityProject(t) {
  const box = await pullProject(t, 1, { tooling: { 'packages/gate/index.js': GATE, 'web/run.js': RUN } });
  const queue = await pullQueue(t, box, { queue: (current, body) => boardJobQueueCall(current, body, { mode: 'pull', trunk: () => box.repo }) });
  return { box, queue, id: box.ids[0] };
}

/** The one gate job's row and receipt for an item. */
function gateOf(board, id) {
  const [row] = jobsOf(board.db, { kind: 'gate', item: id });
  return { row, receipt: row.steps.find(step => step.name === 'receipt').payload.receipt };
}

test('clauses 1 and 2: a pulled proof runs the checkout\'s own runner with pullboard.trunk set, a per-job HOME and temp folder, and PULLBOARD_RUNNER_JOB [P7]', { timeout: 180_000 }, // budget: hang ceiling for a project, one submit and one whole gate in a runner process.
async t => {
  const { box, queue, id } = await parityProject(t);
  submitOne(box, id);
  const steps = join(box.runnerHome, 'parity-steps.jsonl');
  const served = await serveOnce(box, queue.url, 'r-parity', { PULLBOARD_FIXTURE_STEPS: steps, HOME: box.runnerHome });
  assert.equal(served.code, 0, served.output);
  const { row, receipt } = gateOf(queue.board, id);
  assert.equal(receipt.gate.green, true, JSON.stringify(receipt.gate).slice(0, 4000));
  const seen = readFileSync(steps, 'utf8').trim().split('\n').map(line => JSON.parse(line)).find(entry => entry.step === 'proof-env');
  assert.ok(seen, 'the proof ran');
  assert.equal(seen.script, join(seen.cwd, 'web/run.js'), 'clause 1: the proof ran as written, from the checkout, not from an archive of main');
  assert.equal(seen.trunk, 'refs/heads/main', 'clause 1: the job checkout names its trunk, as a pushed runner\'s does');
  assert.equal(seen.job, row.id, 'clause 2: every process of the job carries PULLBOARD_RUNNER_JOB');
  assert.ok(seen.home && seen.home !== box.runnerHome && seen.home.startsWith(join(box.runnerHome, 'r-parity')), `clause 2: HOME is the job's own folder (${seen.home})`);
  assert.ok(seen.tmp && seen.tmp !== tmpdir() && seen.tmp.startsWith(join(box.runnerHome, 'r-parity')), `clause 2: the temp folder is the job's own (${seen.tmp})`);
  assert.notEqual(seen.home, seen.tmp);
});

test('clause 1: a candidate that changed the proof runner\'s imports is refused by name, and its proof never runs [P7]', { timeout: 180_000 }, // budget: as above.
async t => {
  const { box, queue, id } = await parityProject(t);
  submitOne(box, id, { path: 'web/run.js', body: `import { hostname } from 'node:os';\n${RUN}`, subject: 'feat(web): runner reads the host [G1]' });
  const steps = join(box.runnerHome, 'refused-steps.jsonl');
  const served = await serveOnce(box, queue.url, 'r-refuse', { PULLBOARD_FIXTURE_STEPS: steps });
  assert.equal(served.code, 0, served.output);
  const { receipt } = gateOf(queue.board, id);
  assert.equal(receipt.gate.green, false);
  assert.deepEqual(receipt.gate.analysis.refusals.map(refusal => [refusal.part, refusal.code, refusal.paths]), [['proof', 'PROOF_RUNNER_CHANGED', ['web/run.js']]]);
  assert.match(receipt.gate.analysis.refusals[0].message, /next: /u);
  assert.deepEqual(receipt.gate.phases, [], 'no phase ran');
});
