/** pullboard runner serve runs a submit's gate job: it reads the job's request, runs it in the candidate checkout and posts the gate's receipt line [P7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { jobsOf } from '../../../../packages/jobs/index.js';
import { jobQueueCall } from '../../../../packages/api/index.js';
import { GATE_RECEIPT as RUNNER_GATE_RECEIPT } from '../../../../packages/drive/index.js';
import { GATE_RECEIPT } from '../../src/io/submit/pull.js';
import { pullProject } from '../../tests/fixtures/pull.js';
import { pullQueue } from '../../tests/fixtures/pull.js';
import { serveOnce } from '../../tests/fixtures/pull.js';
import { submitOne } from '../../tests/fixtures/pull.js';

test('clause 1: runner serve claims a gate job, calls request, runs request.run in the candidate checkout with request.input on stdin and posts the PULLBOARD_GATE_RECEIPT line as the receipt [P7]', { timeout: 180_000 }, // budget: hang ceiling for a project, one submit and one whole gate in a runner process.
async t => {
  assert.equal(RUNNER_GATE_RECEIPT, GATE_RECEIPT, 'the runner reads the prefix the submit\'s gate job prints');
  const box = await pullProject(t, 1);
  const [id] = box.ids;
  const { commit } = submitOne(box, id);
  const actions = [];
  const steps = join(box.runnerHome, 'steps.jsonl');
  // Each queue call the runner process makes is noted, in order, before the board answers it.
  const { board, url } = await pullQueue(t, box, { queue: (current, body) => { actions.push(body.action); return jobQueueCall(current.db, body, { mode: 'pull', trunk: () => box.repo }); } });
  const served = await serveOnce(box, url, 'r-gate', { PULLBOARD_FIXTURE_STEPS: steps });
  assert.equal(served.code, 0, served.output);
  assert.deepEqual(actions, ['claim', 'request', 'receipt'], 'one claim, one request read, one receipt');
  const [row] = jobsOf(board.db, { kind: 'gate', item: id });
  assert.equal(row.step, 'done');
  const [{ payload }] = row.steps.filter(step => step.name === 'receipt');
  assert.equal(payload.runner, 'r-gate');
  const { receipt } = payload;
  assert.equal(receipt.status, 0, JSON.stringify(receipt));
  assert.equal(receipt.commit, commit);
  assert.equal(receipt.gate.green, true, JSON.stringify(receipt.gate));
  assert.deepEqual([receipt.gate.main, receipt.gate.source], [box.git(box.repo, 'rev-parse', 'main'), commit], 'the receipt is the gate\'s own line, bound to main and the candidate');
  assert.deepEqual(receipt.gate.phases.map(phase => [phase.role, phase.status]), [['check', 0], ['proof', 0]]);
  const parts = new Set(readFileSync(steps, 'utf8').trim().split('\n').map(line => JSON.parse(line).step));
  for (const part of ['authorization', 'doctrine', 'static', 'cells', 'selection', 'proof']) assert.ok(parts.has(part), `${part} ran inside the runner's job`);
});

test('clause 1: a gate job whose run prints no receipt line is posted red with its output, never green [P7]', { timeout: 180_000 }, // budget: as clause 1.
async t => {
  const box = await pullProject(t, 1);
  const [id] = box.ids;
  const { commit } = submitOne(box, id);
  const queue = await pullQueue(t, box);
  // The request's run is replaced by one that reads its stdin and prints it, without a receipt line.
  queue.board.db.prepare("UPDATE job_step SET job_step_payload = json_set(job_step_payload, '$.request.run', json('[\"node\", \"-e\", \"process.stdin.pipe(process.stdout)\"]')) WHERE job_step_name = 'offered'").run();
  const served = await serveOnce(box, queue.url, 'r-silent');
  assert.equal(served.code, 0, served.output);
  const [row] = jobsOf(queue.board.db, { kind: 'gate', item: id });
  const { receipt } = row.steps.find(step => step.name === 'receipt').payload;
  assert.equal(receipt.commit, commit);
  assert.equal(receipt.gate.green, false);
  assert.match(receipt.gate.error, /printed no PULLBOARD_GATE_RECEIPT line \(exit 0\).*"check":"true"/su, 'the job read request.input on stdin; its output is in the red receipt');
});
