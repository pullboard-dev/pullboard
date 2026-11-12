/** pullboard runner serve pulls jobs from a board URL and fetches candidates from the board's trunk remote setting [P7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { apiHttpBox } from '../../tests/fixtures/api.js';
import { fixtureMachineSettings } from '../../tests/fixtures/testkit.js';
import { configFromSource } from '../../../../packages/config/index.js';
import { loadMachineSettings } from '../../../../packages/config/index.js';
import { trunkRemote } from '../../../../packages/config/index.js';
import { jobView } from '../../../../packages/jobs/index.js';
import { offerJob } from '../../../../packages/api/index.js';
import { serveRunner } from '../../../../packages/drive/index.js';
import { landingRemote } from '../../../../packages/landing/index.js';

/**
 * A local board serving its job queue under pull, plus a trunk remote: a bare repository apart from the board host's
 * repository, holding one commit whose check.js prints a marker. The board's pullboard.json names that remote.
 */
async function pullBoard(t, { setting = true } = {}) {
  const box = await apiHttpBox(t);
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { gate: { runnerDispatch: 'pull' } });
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: box.env, encoding: 'utf8' }).trim();
  const trunk = join(box.dir, 'trunk.git');
  const source = join(box.dir, 'source');
  // Clones of the board host's repository, so the trunk remote starts as a copy and then holds a commit the host lacks.
  git(box.dir, 'clone', '-q', '--bare', box.root, trunk);
  git(box.dir, 'clone', '-q', trunk, source);
  writeFileSync(join(source, 'check.js'), "console.log('ran at the candidate');\nprocess.exit(Number(process.env.FAIL ?? 0));\n");
  git(source, 'add', 'check.js');
  git(source, 'commit', '-q', '-m', 'candidate');
  git(source, 'push', '-q', trunk, 'HEAD:refs/heads/candidate');
  const commit = git(source, 'rev-parse', 'HEAD');
  if (setting) {
    const file = join(box.root, 'pullboard.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), trunk: { remote: trunk } }, null, 2));
  }
  const db = new DatabaseSync(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => db.close());
  return { box, trunk, commit, db, board: `${box.origin}${box.path}?k=${box.key}`, cache: join(box.dir, 'runner-cache') };
}

test('clause 1: runner serve, given only a board URL, claims a job, fetches its commit from the trunk remote, runs it and posts the receipt, with no ssh to the runner [P7]', { timeout: 90_000 }, // budget: hang ceiling for a private init, API start and two git fetches.
async (t) => {
  const { box, commit, db, board, cache } = await pullBoard(t);
  assert.notEqual(spawnSync('git', ['cat-file', '-e', commit], { cwd: box.root, env: box.env }).status, 0, 'the board host repository does not hold the candidate');
  offerJob(db, { id: 'gate:serve', kind: 'gate', needs: ['node22'], candidate: commit, run: [process.execPath, 'check.js'] });
  const calls = [];
  const fetchImpl = (url, init) => { calls.push(String(url)); return fetch(url, init); };
  const served = await serveRunner({ board, runner: 'r-pull', capabilities: ['node22'], cache, once: true, fetchImpl, timing: { idleMs: 10 } });
  assert.deepEqual(served.jobs.map(job => [job.job, job.outcome, job.receipt.status]), [['gate:serve', 'posted', 0]]);
  const view = jobView(db, 'gate:serve');
  assert.equal(view.step, 'done');
  const { receipt } = view.steps.find(step => step.name === 'receipt').payload;
  assert.equal(receipt.commit, commit);
  assert.match(receipt.tail, /ran at the candidate/u, 'the job ran at the commit fetched from the trunk remote');
  assert.ok(calls.every(url => url === `${box.origin}${box.path}/jobs`), 'the runner only calls the board\'s jobs URL');
  assert.deepEqual(loadMachineSettings().runners ?? [], [], 'the board knows no ssh runner: nothing ever connects into r-pull');
  assert.equal(served.waits.length, 0);
});

test('clause 2: while the board is unreachable the runner backs off and retries, and the job is never recorded red [P7]', { timeout: 90_000 }, // budget: as clause 1.
async (t) => {
  const { commit, db, board, cache } = await pullBoard(t);
  offerJob(db, { id: 'gate:flaky-link', kind: 'gate', needs: ['node22'], candidate: commit, run: [process.execPath, 'check.js'] });
  // The link drops for the first two claims and the first receipt, as a Wi-Fi gap or a board restart would.
  let drops = { claim: 2, receipt: 1 };
  const fetchImpl = async (url, init) => {
    const { action } = JSON.parse(init.body);
    if (drops[action] > 0) { drops[action] -= 1; throw new TypeError('fetch failed'); }
    return fetch(url, init);
  };
  const slept = [];
  const served = await serveRunner({ board, runner: 'r-wifi', capabilities: ['node22'], cache, once: true, fetchImpl,
    sleep: async ms => { slept.push(ms); }, timing: { firstMs: 100, maxMs: 1_000 } });
  assert.deepEqual(served.waits, [100, 200, 100], 'each failed call waits longer than the last, and a success resets the backoff');
  const receipts = jobView(db, 'gate:flaky-link').steps.filter(step => step.name === 'receipt');
  assert.deepEqual(receipts.map(step => step.payload.receipt.status), [0], 'one green receipt, no red for the outage');

  // A board that never answers: the runner keeps waiting, records nothing, and stops cleanly when told to.
  const closed = await new Promise(resolve => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); }); });
  const stop = new AbortController();
  let tries = 0;
  const down = await serveRunner({ board: `http://127.0.0.1:${closed}/api/v1/boards/b?k=x`, runner: 'r-down', capabilities: ['node22'], cache, signal: stop.signal,
    sleep: async () => { tries += 1; if (tries === 4) stop.abort(); }, timing: { firstMs: 100, maxMs: 300 } });
  assert.deepEqual(down.waits, [100, 200, 300, 300], 'the backoff caps and keeps trying');
  assert.deepEqual(down.jobs, [], 'no job is touched while the board is away');
});

test('clause 3: the trunk remote is one board setting apart from the board host, read by runners through the claim and by the lander [P7]', { timeout: 90_000 }, // budget: as clause 1.
async (t) => {
  const { box, trunk, commit, db, board, cache } = await pullBoard(t);
  assert.equal(trunkRemote(box.root), trunk);
  assert.notEqual(trunk, box.root, 'the trunk remote is not the board host');
  assert.equal(landingRemote(box.root, 'refs/heads/main'), trunk, 'the lander pushes trunk where runners fetch');
  offerJob(db, { id: 'gate:setting', kind: 'gate', needs: [], candidate: commit, run: [process.execPath, 'check.js'] });
  const answers = [];
  const fetchImpl = async (url, init) => { const response = await fetch(url, init); answers.push(await response.clone().json()); return response; };
  await serveRunner({ board, runner: 'r-setting', capabilities: [], cache, once: true, fetchImpl });
  assert.equal(answers.find(answer => answer.claim)?.trunk, trunk, 'a claim names the board\'s trunk remote');

  assert.deepEqual(configFromSource('{}').trunk, { remote: '' }, 'unset by default');
  assert.throws(() => configFromSource(JSON.stringify({ trunk: { remote: 'https://me:secret@example.invalid/r.git' } })), /must not carry a password/u);
  assert.throws(() => configFromSource(JSON.stringify({ trunk: { remote: '--upload-pack=x' } })), /one git URL or path/u);
});

test('clause 1: a candidate the trunk remote lacks is released to the queue, never posted red [P7]', { timeout: 90_000 }, // budget: as clause 1.
async (t) => {
  const { db, board, cache } = await pullBoard(t);
  offerJob(db, { id: 'gate:missing', kind: 'gate', needs: [], candidate: 'f'.repeat(40), run: [process.execPath, 'check.js'] });
  const served = await serveRunner({ board, runner: 'r-miss', capabilities: [], cache, once: true });
  assert.deepEqual(served.jobs, [{ job: 'gate:missing', outcome: 'released' }]);
  const view = jobView(db, 'gate:missing');
  assert.equal(view.steps.some(step => step.name === 'receipt'), false);
  assert.equal(view.leaseOwner, null, 'the job is open for the next runner');
});

test('#5805 clause 3: one runner serve claims two offered jobs within a second and runs them at once, each in its own checkout [P7]', { timeout: 90_000 }, // budget: as clause 1.
async (t) => {
  const { commit, db, board, cache } = await pullBoard(t);
  // Each job holds its slot for 1.5 s and names its own checkout, so overlap and separate folders both show in the receipts.
  const slow = [process.execPath, '-e', "console.log('folder ' + process.cwd()); setTimeout(() => console.log('slow done'), 1500);"];
  offerJob(db, { id: 'gate:slot-a', kind: 'gate', needs: [], candidate: commit, run: slow });
  offerJob(db, { id: 'gate:slot-b', kind: 'gate', needs: [], candidate: commit, run: slow });
  const claimed = [], stop = new AbortController();
  let posted = 0;
  const fetchImpl = async (url, init) => {
    const response = await fetch(url, init);
    const answer = await response.clone().json();
    if (answer.claim) claimed.push({ job: answer.claim.job, at: Date.now() });
    return response;
  };
  const served = await serveRunner({ board, runner: 'r-slots', capabilities: [], cache, jobs: 2, signal: stop.signal, fetchImpl, timing: { idleMs: 10 },
    say: line => { if (line.startsWith('posted ') && ++posted === 2) stop.abort(); } });
  assert.equal(served.slots, 2);
  assert.deepEqual(claimed.map(row => row.job).sort(), ['gate:slot-a', 'gate:slot-b'], 'one serve claimed both jobs');
  assert.ok(Math.abs(claimed[1].at - claimed[0].at) < 1000, `both claims landed within a second (${claimed[1].at - claimed[0].at} ms)`);
  assert.deepEqual(served.jobs.map(job => [job.job, job.outcome, job.receipt.status]).sort(), [['gate:slot-a', 'posted', 0], ['gate:slot-b', 'posted', 0]]);
  const folders = served.jobs.map(job => /folder (\S+)/u.exec(job.receipt.tail)[1]);
  assert.notEqual(folders[0], folders[1], 'each concurrent job ran in its own checkout');
  assert.ok(served.jobs.every(job => /slow done/u.test(job.receipt.tail)), 'both ran to the end, the second claimed while the first held its slot');
});

test('#5805 clauses 1 and 2: a pulled job\'s detached child carries PULLBOARD_RUNNER_JOB and is gone before the job\'s receipt posts [P7]', { timeout: 90_000 }, // budget: as clause 1.
async (t) => {
  const { box, commit, db, board, cache } = await pullBoard(t);
  const seen = join(box.dir, 'child.json');
  // The job starts a child in its own session, as a test's pullboard view does, writes what the child sees, and exits.
  const child = `require('node:fs').writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ pid: process.pid, job: process.env.PULLBOARD_RUNNER_JOB ?? null })); setInterval(() => {}, 1000);`;
  const job = `const { spawn } = require('node:child_process'); const fs = require('node:fs');
spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { detached: true, stdio: 'ignore' }).unref();
const wait = () => fs.existsSync(${JSON.stringify(seen)}) ? console.log('child started') : setTimeout(wait, 20); wait();`;
  offerJob(db, { id: 'gate:leftover', kind: 'gate', needs: [], candidate: commit, run: [process.execPath, '-e', job] });
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  let atReceipt = null;
  const fetchImpl = async (url, init) => {
    if (JSON.parse(init.body).action === 'receipt') { const { pid } = JSON.parse(readFileSync(seen, 'utf8')); atReceipt = alive(pid); }
    return fetch(url, init);
  };
  t.after(() => { try { process.kill(JSON.parse(readFileSync(seen, 'utf8')).pid, 'SIGKILL'); } catch { /* already gone */ } });
  const served = await serveRunner({ board, runner: 'r-reap', capabilities: [], cache, once: true, fetchImpl, timing: { idleMs: 10 } });
  assert.deepEqual(served.jobs.map(row => [row.job, row.outcome, row.receipt.status]), [['gate:leftover', 'posted', 0]]);
  assert.match(served.jobs[0].receipt.tail, /child started/u);
  assert.equal(JSON.parse(readFileSync(seen, 'utf8')).job, 'gate:leftover', 'clause 2: the job\'s child carries PULLBOARD_RUNNER_JOB');
  assert.equal(atReceipt, false, 'clause 1: the detached child had ended when the receipt posted');
});
