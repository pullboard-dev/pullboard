/** A serve shares its runner's cores out between the jobs it runs at once, so its jobs together never oversubscribe the runner (#5919) [P7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { serveRunner } from '../../../index.js';
import { jobWorkers } from '../../../src/io/pull.js';
import { JOB_WORKERS_ENV } from '../../../light.js';
import { privateFixtureFiles } from '../../../../../apps/cli/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../../apps/cli/tests/fixtures/child.js';

const BOARD = 'http://board.invalid/api/v1/boards/b?k=x';
const CONCURRENCY = pathToFileURL(resolve(import.meta.dirname, '../../../../gate/src/io/test/concurrency.js')).href;

test('#5919 clause 1: a serve running N jobs on C cores gives each job floor(C/N) workers, at least 1 [P7]', () => {
  assert.equal(jobWorkers(3, 10), 3);
  assert.equal(jobWorkers(1, 10), 10, 'a lone job keeps every core');
  assert.equal(jobWorkers(4, 16), 4);
  assert.equal(jobWorkers(3, 8), 2);
  assert.equal(jobWorkers(12, 10), 1, 'more jobs than cores still leaves each job one worker');
  assert.equal(jobWorkers(1, 1), 1);
});

test('#5919 clause 2: with 3 jobs on a 10-core runner the job env carries 3 workers, and its test run uses 3 files at once, never 10 [P7]', { timeout: 60_000 }, // budget: one local git checkout and one node child.
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
    const served = await serveRunner({ board: BOARD, runner: 'r-workers', capabilities: [], cache, jobs: 3, cores: 10, signal: stop.signal, fetchImpl, sleep, timing: { idleMs: 1 } });
    assert.equal(served.slots, 3);
    assert.equal(receipts.length, 1, JSON.stringify(receipts));
    assert.equal(receipts[0].status, 0, receipts[0].tail);
    assert.match(receipts[0].tail, /^WORKERS 3$/mu, 'the job env carries its share of 3 workers');
    assert.match(receipts[0].tail, /^FILES 3$/mu, 'the job\'s test run spreads over 3 files at once, not the runner\'s 10 cores');
  });
