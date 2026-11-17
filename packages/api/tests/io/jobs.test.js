/** The board API serves its runner job queue on loopback, only under gate.runnerDispatch pull [P7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellBoard } from '../../../store/tests/fixtures/cell.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { fetchFresh } from '../../../sync/tests/fixtures/http.js';
import { runnerDispatchMode } from '../../../config/index.js';
import { jobView } from '../../../jobs/index.js';
import { createApiHandler } from '../../index.js';
import { jobQueueCall } from '../../index.js';
import { offerJob } from '../../index.js';

/** The renderer the API takes as a port: a refusal becomes its public error body. */
function refusalDocument(error) {
  return { error: { code: error.code ?? 'INTERNAL', message: String(error.message) } };
}

test('api.jobs.clauses-over-loopback-api-runner: clauses 1-3: over the loopback API a runner claims by capability, a rival gets nothing, and its receipt lands under the job [P7]', async (t) => {
  const { root } = privateFixtureFiles('pullboard-jobs-api-');
  const home = join(root, 'machine-home');
  mkdirSync(home, { recursive: true });
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; });
  const db = cellBoard(t, join(root, 'board.sqlite')).db;
  offerJob(db, { id: 'gate:http', kind: 'gate', needs: ['node22'] });
  // The local adapter's jobs port, as packages/api/src/io/main.js wires it; the queue mode is a port, so the test names it: refused first, then pull [P7].
  let mode = 'controller';
  const handler = createApiHandler({ refusalDocument,
    authenticate: () => ({ local: true }),
    board: (id) => ({ id }),
    jobs: (board, body) => jobQueueCall(db, body, { mode }),
  });
  const server = createServer(handler);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => { handler.close(); server.close(done); server.closeIdleConnections(); }));
  const jobs = async (body) => {
    const response = await fetchFresh(`http://127.0.0.1:${server.address().port}/api/v1/boards/fixture/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, document: await response.json() };
  };

  const off = await jobs({ action: 'claim', runner: 'r-a', capabilities: ['node22'] });
  assert.deepEqual([off.status, off.document.error.code], [400, 'JOBS_NOT_PULL'], 'the controller path never serves the queue');
  assert.equal(jobView(db, 'gate:http').leaseOwner, null);

  mode = runnerDispatchMode();
  assert.equal((await jobs({ action: 'claim', runner: 'r-thin', capabilities: [] })).document.claim, null, 'a runner without node22 takes nothing');
  const won = await jobs({ action: 'claim', runner: 'r-a', capabilities: ['node22', 'browser'] });
  assert.equal(won.status, 200);
  assert.deepEqual([won.document.claim.job, won.document.claim.attempt], ['gate:http', 1]);
  assert.equal((await jobs({ action: 'claim', runner: 'r-b', capabilities: ['node22'] })).document.claim, null, 'a second claimant is refused while the lease lives');
  const { token } = won.document.claim;
  assert.equal((await jobs({ action: 'renew', job: 'gate:http', runner: 'r-a', token })).document.renewed, true);

  const forged = await jobs({ action: 'receipt', job: 'gate:http', runner: 'r-b', token, receipt: { status: 0 } });
  assert.equal(forged.document.error.code, 'JOB_LEASE_MOVED', 'a receipt from a runner without the claim is refused');
  const posted = await jobs({ action: 'receipt', job: 'gate:http', runner: 'r-a', token, receipt: { status: 0, digest: 'f00d' } });
  assert.deepEqual([posted.status, posted.document.recorded], [200, true]);
  const view = jobView(db, 'gate:http');
  assert.equal(view.step, 'done');
  assert.deepEqual(view.steps.find(step => step.name === 'receipt').payload, { runner: 'r-a', attempt: 1, receipt: { status: 0, digest: 'f00d' } });
});

test('api.jobs.large-change-gate-request-over: clause 1: a large-change gate request over 60 KiB is offered with its big parts named, and the runner holding it reads it back whole [P7]', (t) => {
  const { root } = privateFixtureFiles('pullboard-jobs-large-');
  const db = cellBoard(t, join(root, 'board.sqlite')).db;
  // Shaped as submit's gate request (#5417): inlined entry code, a config whose lanes block grew (#6150), and a change of 2,000 files.
  const owns = Array.from({ length: 1500 }, (_, n) => `apps/view/src/logic/render/part-${n}.js`);
  const files = Array.from({ length: 2000 }, (_, n) => `packages/big/src/file-${n}.js`);
  const request = { run: ['node', '--input-type=module', '-e', 'x'.repeat(2600)], commits: ['a'.repeat(40)],
    input: { main: 'a'.repeat(40), entry: 'e'.repeat(17_580), data: { check: 'node apps/cli/pullboard.js test packages/api/tests/io/jobs.test.js', shards: true,
      analysisEntry: 'n'.repeat(15_271), analysis: { criterion: '1. large [test]', config: { lanes: { view: { owns } } }, crossRunTests: files.slice(0, 300) } } },
    submit: { agentId: 'core-1', digest: 'd'.repeat(64), tree: 't'.repeat(40), files } };
  const size = Buffer.byteLength(JSON.stringify(request));
  assert.ok(size > 60 * 1024, `the request is a large change (${size} bytes)`);

  offerJob(db, { id: 'gate:large', kind: 'gate', needs: ['node22'], item: 5417, candidate: 'c'.repeat(40), base: 'a'.repeat(40), request });
  const row = db.prepare("SELECT job_step_payload FROM job_step WHERE job_step_job = 'gate:large' AND job_step_name = 'offered'").get();
  assert.ok(Buffer.byteLength(row.job_step_payload) <= 60 * 1024, 'the offered row the claim scan reads stays under REQUEST_BYTES');
  const offered = JSON.parse(row.job_step_payload).request;
  assert.equal(offered.input.data.check, request.input.data.check, 'small fields stay inline for the board readers');
  assert.equal(offered.submit.files.$named, 'request', 'the change list is named by the job\'s request step, not inlined');
  assert.equal(jobView(db, 'gate:large').step, 'offered');

  const claim = jobQueueCall(db, { action: 'claim', runner: 'r-a', capabilities: ['node22'] }, { mode: 'pull' }).claim;
  assert.equal(claim?.job, 'gate:large', 'the large-change job is offered and claimable');
  const input = jobQueueCall(db, { action: 'request', job: 'gate:large', runner: 'r-a', token: claim.token }, { mode: 'pull' });
  assert.deepEqual(input.request, request, 'the runner holding the job reads the whole request back');
});
