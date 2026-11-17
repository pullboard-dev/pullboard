/** A runner that takes a gate job carrying exclusive timing claims nothing else until it ends and posts exclusive evidence [C7,#8187]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { serveRunner } from '../../../../drive/index.js';
import { testGit as pullGit } from '../../fixtures/git.js';
import { privateFixtureFiles } from '../../../../../apps/cli/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../../apps/cli/tests/fixtures/child.js';

const BOARD = 'http://board.invalid/api/v1/boards/b?k=x';
const GATE = `process.stdin.resume(); process.stdin.on('end', () => console.log('PULLBOARD_GATE_RECEIPT ' + JSON.stringify({ version: 1, green: true })));`;

/** Serve two gate jobs, the first one frozen with check timing; the log says what the runner did, in order. */
async function serveTwo(t, { timing }) {
  const { root: trunk } = privateFixtureFiles('pullboard-exclusive-trunk-');
  const { root: cache } = privateFixtureFiles('pullboard-exclusive-cache-');
  t.after(() => { rmSync(trunk, { recursive: true, force: true }); rmSync(cache, { recursive: true, force: true }); });
  const sh = (...args) => runFixtureGit(['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', ...args], { cwd: trunk });
  sh('init', '-q', '-b', 'main');
  writeFileSync(join(trunk, 'tracked.txt'), 'one\n');
  sh('add', '.');
  sh('commit', '-q', '-m', 'one');
  const commit = sh('rev-parse', 'HEAD');
  const log = [], receipts = {};
  let handed = 0;
  const reply = document => ({ status: 200, json: async () => document });
  const fetchImpl = async (_url, { body }) => {
    const call = JSON.parse(body);
    if (call.action === 'claim') {
      handed += 1;
      log.push(`claim ${handed}`);
      return reply({ trunk, claim: handed > 2 ? null : { job: `g${handed}`, attempt: 1, token: `t${handed}`, candidate: commit, base: commit, run: [] } });
    }
    if (call.action === 'request') {
      return reply({ request: { run: ['node', '-e', GATE], input: { main: commit, entry: 'x', data: handed && call.job === 'g1' && timing ? { checkTiming: true } : {} }, commits: [] } });
    }
    if (call.action === 'receipt') { log.push(`receipt ${call.job}`); receipts[call.job] = call.receipt; }
    return reply({ ok: true, renewed: true });
  };
  const stop = new AbortController();
  const sleep = ms => new Promise(done => setTimeout(() => { if (Object.keys(receipts).length >= 2) stop.abort(); done(); }, Math.max(ms, 5)));
  await serveRunner({ git: pullGit, board: BOARD, runner: 'r-exclusive', capabilities: [], cache, jobs: 2, cores: 4, signal: stop.signal, fetchImpl, sleep, timing: { idleMs: 1 } });
  return { log, receipts };
}

test('runners.exclusive-timing.n8187-clause-1-a-runner-holding: #8187 clause 1: a runner holding a gate job with exclusive timing claims no other job until it ends [C7]', { timeout: 60_000 }, // budget: one local git checkout and two node children.
  async t => {
    const { log } = await serveTwo(t, { timing: true });
    assert.ok(log.indexOf('receipt g1') !== -1 && log.indexOf('claim 2') > log.indexOf('receipt g1'), `the second claim waits for the first receipt: ${log.join(', ')}`);
  });

test('runners.exclusive-timing.n8187-clause-1-the-timed-job: #8187 clause 1: the timed job posts exclusive:true timing evidence in its receipt [C7]', { timeout: 60_000 }, // budget: one local git checkout and two node children.
  async t => {
    const { receipts } = await serveTwo(t, { timing: true });
    const { timing, exclusive, unfencedClients, admittedAt, finishedAt } = receipts.g1;
    assert.deepEqual({ timing, exclusive, unfencedClients }, { timing: true, exclusive: true, unfencedClients: [] });
    assert.ok(Date.parse(finishedAt) >= Date.parse(admittedAt));
    assert.equal(receipts.g1.gate.green, true);
  });

test('runners.exclusive-timing.n8187-clause-1-a-gate-job: #8187 clause 1: a gate job without timing leaves the runner free and its receipt carries no timing claim [C7]', { timeout: 60_000 }, // budget: one local git checkout and two node children.
  async t => {
    const { receipts } = await serveTwo(t, { timing: false });
    assert.equal('exclusive' in receipts.g1, false);
    assert.equal('timing' in receipts.g1, false);
  });
