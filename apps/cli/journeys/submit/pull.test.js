/** Under gate.runnerDispatch pull a submit writes one gate job row and returns; a runner pulls the whole gate and posts one receipt [P7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { watch } from 'node:fs';
import { join } from 'node:path';
import { getItem } from '../../../../packages/store/index.js';
import { submitHandoff } from '../../../../packages/store/index.js';
import { jobQueueCall } from '../../../../packages/api/index.js';
import { jobsOf } from '../../../../packages/jobs/index.js';
import { GATE_RECEIPT } from '../../src/io/submit/pull.js';
import { hostProcesses } from '../../tests/fixtures/pull.js';
import { pullProject } from '../../tests/fixtures/pull.js';
import { pullQueue } from '../../tests/fixtures/pull.js';
import { submitOne } from '../../tests/fixtures/pull.js';

/**
 * The board's job queue served on loopback, as the board API serves it, and a small runner client of it: claim, read the
 * request, fetch the candidate from the trunk remote into its own cache, run the job's argv with the request's input
 * on stdin, and post one receipt. Why in the test: the shipped runner loop is #5690's; this keeps the test off it.
 */
async function loopbackRunner(t, box) {
  const { board, call } = await pullQueue(t, box, { queue: (current, body) => jobQueueCall(current.db, body, { mode: 'pull' }) });
  const env = { ...box.env };
  for (const key of Object.keys(env)) if (key.startsWith('PULLBOARD_')) delete env[key];
  /** Claim one job and check its candidate out; null when the queue is empty. */
  const take = async runner => {
    const { claim } = await call({ action: 'claim', runner, capabilities: ['node22'] });
    if (!claim) return null;
    const held = { job: claim.job, runner, token: claim.token };
    const input = await call({ action: 'request', ...held });
    const folder = join(box.runnerHome, claim.job.replace(/[^\w.-]/gu, '-'));
    execFileSync('git', ['clone', '-q', '--no-checkout', '--no-tags', box.repo, folder], { env });
    execFileSync('git', ['fetch', '-q', '--no-tags', 'origin', `refs/pullboard/gate/${input.item}`], { cwd: folder, env });
    execFileSync('git', ['-c', 'advice.detachedHead=false', 'checkout', '-q', '--detach', input.candidate], { cwd: folder, env });
    return { held, input, folder };
  };
  /** Run a taken job's argv in its checkout and post its one receipt; observe() runs on each event the job's process emits. */
  const run = async ({ held, input, folder }, observe = () => {}) => {
    const { run: argv, input: stdin } = input.request;
    const child = spawn(argv[0] === 'node' ? process.execPath : argv[0], argv.slice(1), { cwd: folder, env: { ...env, PULLBOARD_FIXTURE_JOB: held.job }, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    // Each step a part records is written while the job's processes are alive, so a sample there sees them running.
    const steps = watch(join(folder, '.git'), observe);
    child.once('spawn', observe);
    child.stdout.on('data', chunk => { out.push(chunk); observe(); });
    child.stderr.on('data', chunk => { out.push(chunk); observe(); });
    child.stdin.end(JSON.stringify(stdin));
    const status = await new Promise(done => child.once('close', done)).finally(() => steps.close());
    const line = Buffer.concat(out).toString('utf8').split('\n').find(row => row.startsWith(GATE_RECEIPT));
    assert.ok(line, `job ${held.job} printed no receipt:\n${Buffer.concat(out).toString('utf8').slice(-4000)}`);
    const gate = JSON.parse(line.slice(GATE_RECEIPT.length));
    await call({ action: 'receipt', ...held, receipt: { status, gate } });
    return { job: held.job, folder, status, gate };
  };
  return { board, take, run };
}

test('clauses 1 and 3: ten pull submits each write one gate job row and return; the host process count stays flat while the ten gates run [P7]', async t => {
  const box = await pullProject(t, 10);
  const before = hostProcesses(box.dir);
  const submitted = [];
  for (const id of box.ids) {
    submitted.push(submitOne(box, id));
    assert.equal(hostProcesses(box.dir), before, `submit #${id} left a process behind on the submitting host`);
  }
  for (const { document } of submitted) assert.equal(document.queued, true);
  const runner = await loopbackRunner(t, box);
  const rows = jobsOf(runner.board.db, { kind: 'gate' });
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

test('clause 2: authorization, doctrine, static checks, selection and tests all run inside the one runner job and post one receipt [P7]', async t => {
  const box = await pullProject(t, 1);
  const [id] = box.ids;
  const { commit } = submitOne(box, id);
  const runner = await loopbackRunner(t, box);
  const job = await runner.take('runner-solo');
  assert.equal(job.input.candidate, commit);
  assert.equal(job.input.request.run.every(arg => typeof arg === 'string' && Buffer.byteLength(arg) <= 4096), true, 'the run is a short argv');
  assert.equal(await runner.take('runner-rival'), null, 'a second runner gets nothing while the lease lives');
  const result = await runner.run(job);
  const steps = readFileSync(join(job.folder, '.git', 'gate-steps.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const names = new Set(steps.map(step => step.step));
  for (const part of ['authorization', 'doctrine', 'static', 'placement', 'cells', 'selection', 'admission', 'proof']) assert.ok(names.has(part), `${part} ran in the runner job`);
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
