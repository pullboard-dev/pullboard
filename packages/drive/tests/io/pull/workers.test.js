/** A serve shares its runner's cores out between the jobs it runs at once, so its jobs together never oversubscribe the runner (#5919) [P7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { serveRunner } from '../../../index.js';
import { testGit as pullGit } from '../../fixtures/git.js';
import { jobWorkers } from '../../../src/io/pull.js';
import { JOB_WORKERS_ENV } from '../../../light.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../gate/tests/fixtures/child.js';

const BOARD = 'http://board.invalid/api/v1/boards/b?k=x';
const CONCURRENCY = pathToFileURL(resolve(import.meta.dirname, '../../../../gate/src/io/test/concurrency.js')).href;

test('drive.workers.c-5919-clause-1-a-job: #5919 clause 1: a job gets twice its share of the cores, at least 2 [P7]', () => {
  assert.equal(jobWorkers(3, 10), 7);
  assert.equal(jobWorkers(1, 10), 20, 'a lone job may overlap its waits');
  assert.equal(jobWorkers(12, 10), 2, 'more jobs than cores still leaves each job two workers');
  assert.equal(jobWorkers(1, 1), 2);
});

test('drive.workers.c-6464-clause-1-with-20: #6464 clause 1: with 20 slots on a 10-core runner, a job with 4 files runs at least 2 files at once [C7]', () => {
  assert.ok(jobWorkers(20, 10, 4) >= 2);
  assert.equal(jobWorkers(20, 10, 4), 2);
  assert.equal(jobWorkers(16, 10, 4), 2);
});

test('drive.workers.c-6464-clause-2-a-jobs: #6464 clause 2: a job\'s workers never exceed its file count [C7]', () => {
  assert.equal(jobWorkers(1, 10, 3), 3);
  assert.equal(jobWorkers(2, 10, 1), 1);
  for (const [slots, cores, files] of [[1, 64, 5], [3, 10, 2], [20, 10, 4], [4, 16, 9]]) assert.ok(jobWorkers(slots, cores, files) <= files);
});

test('drive.workers.c-5919-clause-2-with-3: #5919 clause 2: with 3 jobs on a 10-core runner the job env carries 7 workers, and its test run uses 7 files at once [P7]', { timeout: 60_000 }, // budget: one local git checkout and one node child.
  async t => {
    const { root: trunk } = privateFixtureFiles('pullboard-workers-trunk-');
    const { root: cache } = privateFixtureFiles('pullboard-workers-cache-');
    t.after(() => { rmSync(trunk, { recursive: true, force: true }); rmSync(cache, { recursive: true, force: true }); });
    const sh = (...args) => runFixtureGit(['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', ...args], { cwd: trunk });
    sh('init', '-q', '-b', 'main');
    writeFileSync(join(trunk, 'tracked.txt'), 'one\n');
    sh('add', '.');
    sh('commit', '-q', '-m', 'one');
    const commit = sh('rev-parse', 'HEAD');
    // The job prints its worker share, then asks the real test runner policy how many files it would run, as a pulled run does.
    const script = `console.log('WORKERS ' + (process.env.${JOB_WORKERS_ENV} ?? 'none'));`
      + `import(${JSON.stringify(CONCURRENCY)}).then(m => console.log('FILES ' + m.testConcurrency(process.cwd(), m.executionCores({ ...process.env, PULLBOARD_PULLED_JOB: '1' })).files));`;
    const receipts = [];
    let handed = false;
    const reply = document => ({ status: 200, json: async () => document });
    const fetchImpl = async (_url, { body }) => {
      const call = JSON.parse(body);
      if (call.action === 'claim') {
        const claim = handed ? null : { job: 'j1', attempt: 1, token: 't-j1', candidate: commit, base: commit, run: ['node', '-e', script] };
        handed = true;
        return reply({ trunk, claim });
      }
      if (call.action === 'receipt') receipts.push(call.receipt);
      return reply({ ok: true, renewed: true });
    };
    const stop = new AbortController();
    // A real pause between idle claims, so the job's child gets the event loop; the first idle wait after the receipt stops the serve.
    const sleep = ms => new Promise(done => setTimeout(() => { if (receipts.length) stop.abort(); done(); }, Math.max(ms, 5)));
    const served = await serveRunner({ git: pullGit, board: BOARD, runner: 'r-workers', capabilities: [], cache, jobs: 3, cores: 10, signal: stop.signal, fetchImpl, sleep, timing: { idleMs: 1 } });
    assert.equal(served.slots, 3);
    assert.equal(receipts.length, 1, JSON.stringify(receipts));
    assert.equal(receipts[0].status, 0, receipts[0].tail);
    assert.match(receipts[0].tail, /^WORKERS 7$/mu, 'the job env carries its share of 7 workers');
    assert.match(receipts[0].tail, /^FILES 7$/mu, 'the job\'s test run spreads over 7 files at once');
  });

test('drive.workers.c-6307-a-job-whose-environment: #6307: a job whose environment folder removal fails with ENOTEMPTY still posts its receipt, and the serve claims the next job [C7]', { timeout: 60_000 }, // budget: one local git checkout and two node children.
  async t => {
    const { root: trunk } = privateFixtureFiles('pullboard-cleanup-trunk-');
    const { root: cache } = privateFixtureFiles('pullboard-cleanup-cache-');
    t.after(() => { rmSync(trunk, { recursive: true, force: true }); rmSync(cache, { recursive: true, force: true }); });
    const sh = (...args) => runFixtureGit(['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', ...args], { cwd: trunk });
    sh('init', '-q', '-b', 'main');
    writeFileSync(join(trunk, 'tracked.txt'), 'one\n');
    sh('add', '.');
    sh('commit', '-q', '-m', 'one');
    const commit = sh('rev-parse', 'HEAD');
    const receipts = [], said = [];
    let handed = 0;
    const reply = document => ({ status: 200, json: async () => document });
    const fetchImpl = async (_url, { body }) => {
      const call = JSON.parse(body);
      if (call.action === 'claim') {
        handed += 1;
        const claim = handed > 2 ? null : { job: `j${handed}`, attempt: 1, token: `t-j${handed}`, candidate: commit, base: commit, run: ['node', '-e', `console.log('RAN j${handed}')`] };
        return reply({ trunk, claim });
      }
      if (call.action === 'receipt') receipts.push(call);
      return reply({ ok: true, renewed: true });
    };
    // The leftover writer of a test still fills tmp, as on the runners on 12 Nov: every removal refuses.
    const removeFolder = folder => { throw Object.assign(new Error(`ENOTEMPTY: directory not empty, rmdir '${folder}/tmp'`), { code: 'ENOTEMPTY' }); };
    const stop = new AbortController();
    const sleep = ms => new Promise(done => setTimeout(() => { if (receipts.length >= 2) stop.abort(); done(); }, Math.max(ms, 5)));
    const served = await serveRunner({ git: pullGit, board: BOARD, runner: 'r-cleanup', capabilities: [], cache, jobs: 1, cores: 2, signal: stop.signal, fetchImpl, sleep,
      timing: { idleMs: 1 }, removeFolder, say: line => said.push(line) });
    assert.deepEqual(receipts.map(call => call.job), ['j1', 'j2'], 'both jobs posted: the failed removal of j1\'s folder never stopped the serve');
    assert.ok(receipts.every(call => call.receipt.status === 0), JSON.stringify(receipts.map(call => call.receipt.tail)));
    assert.deepEqual(served.jobs.map(entry => entry.outcome), ['posted', 'posted']);
    assert.ok(said.some(line => /left .*environment folder to the prune: ENOTEMPTY/u.test(line)), said.join('\n'));
  });

test('drive.workers.factor-argument: clause 1: jobWorkers takes a factor argument, default 2, and returns ceil(factor*cores/slots), at least 2 and at most its file count [C7]', () => {
  assert.equal(jobWorkers(3, 10), jobWorkers(3, 10, null, 2), 'the default factor is 2');
  assert.equal(jobWorkers(3, 10, null, 1), 4, 'ceil(1*10/3)');
  assert.equal(jobWorkers(3, 10, null, 4), 14, 'ceil(4*10/3)');
  assert.equal(jobWorkers(30, 10, null, 1), 2, 'never under 2');
  assert.equal(jobWorkers(1, 10, 3, 4), 3, 'never over its file count');
});

test('drive.workers.factor-option: clause 2: serveRunner passes its jobWorkerFactor option to jobWorkers for each job, and 2 when absent [C7]', { timeout: 60_000 }, // budget: two local git checkouts and two node children.
  async t => {
    const seen = [];
    for (const options of [{}, { jobWorkerFactor: 1 }]) {
      const { root: trunk } = privateFixtureFiles('pullboard-factor-trunk-');
      const { root: cache } = privateFixtureFiles('pullboard-factor-cache-');
      t.after(() => { rmSync(trunk, { recursive: true, force: true }); rmSync(cache, { recursive: true, force: true }); });
      const sh = (...args) => runFixtureGit(['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', ...args], { cwd: trunk });
      sh('init', '-q', '-b', 'main');
      writeFileSync(join(trunk, 'tracked.txt'), 'one\n');
      sh('add', '.');
      sh('commit', '-q', '-m', 'one');
      const commit = sh('rev-parse', 'HEAD');
      const receipts = [];
      let handed = false;
      const reply = document => ({ status: 200, json: async () => document });
      const fetchImpl = async (_url, { body }) => {
        const call = JSON.parse(body);
        if (call.action === 'claim') {
          const claim = handed ? null : { job: 'j1', attempt: 1, token: 't-j1', candidate: commit, base: commit, run: ['node', '-e', `console.log('WORKERS ' + process.env.${JOB_WORKERS_ENV})`] };
          handed = true;
          return reply({ trunk, claim });
        }
        if (call.action === 'receipt') receipts.push(call.receipt);
        return reply({ ok: true, renewed: true });
      };
      const stop = new AbortController();
      const sleep = ms => new Promise(done => setTimeout(() => { if (receipts.length) stop.abort(); done(); }, Math.max(ms, 5)));
      await serveRunner({ git: pullGit, board: BOARD, runner: 'r-factor', capabilities: [], cache, jobs: 3, cores: 10, signal: stop.signal, fetchImpl, sleep, timing: { idleMs: 1 }, ...options });
      assert.equal(receipts.length, 1, JSON.stringify(receipts));
      seen.push(/^WORKERS (\d+)$/mu.exec(receipts[0].tail)?.[1]);
    }
    assert.deepEqual(seen, ['7', '4'], 'absent gives 2x share (7), factor 1 gives ceil(10/3) = 4');
  });
