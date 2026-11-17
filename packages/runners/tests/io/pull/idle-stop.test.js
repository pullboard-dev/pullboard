/** @pullboard-test-input source-cell packages/runners */
/** An idle local runner exits within 1 s of SIGTERM, and a write it holds finishes first [C7,#8250]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { serveLocalRunner } from '../../../../drive/index.js';
import { serveRunner } from '../../../../drive/index.js';
import { testGit as pullGit } from '../../fixtures/git.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../gate/tests/fixtures/child.js';

const BOARD = 'http://board.invalid/api/v1/boards/b?k=x';
const reply = document => ({ status: 200, json: async () => document });

test('#8250 clause 1: an idle runner serve ends the moment it is stopped, though its idle wait is ten minutes [C7]', { timeout: 30_000 }, // budget: only the stop can end a ten-minute idle wait, so a slow exit fails by timeout.
  async t => {
    const { root: cache } = privateFixtureFiles('pullboard-idle-stop-cache-');
    t.after(() => rmSync(cache, { recursive: true, force: true }));
    const stop = new AbortController();
    let asked;
    const idle = new Promise(resolve => { asked = resolve; });
    const fetchImpl = async () => { asked(); return reply({ claim: null }); };
    const running = serveRunner({ git: pullGit, board: BOARD, runner: 'r-idle', capabilities: [], cache, jobs: 1, cores: 1, signal: stop.signal, fetchImpl, timing: { idleMs: 600_000 } });
    await idle;
    await new Promise(setImmediate);
    stop.abort();
    assert.deepEqual((await running).jobs, []);
  });

test('#8250 clause 1: an idle local runner ends the moment it is stopped, though its heartbeat wait is ten minutes, and removes its state and lock [C7]', { timeout: 30_000 }, // budget: only the stop can end a ten-minute heartbeat wait, so a slow exit fails by timeout.
  async t => {
    const { root: folder } = privateFixtureFiles('pullboard-idle-stop-local-');
    t.after(() => rmSync(folder, { recursive: true, force: true }));
    const stop = new AbortController();
    let opened;
    const ready = new Promise(resolve => { opened = resolve; });
    const open = async () => { opened(); return { origin: 'http://127.0.0.1:1', key: 'k', boards: () => [], close: async () => {} }; };
    const running = serveLocalRunner({ folder, open, capabilities: [], git: pullGit, signal: stop.signal, timing: { heartbeatMs: 600_000 } });
    await ready;
    await new Promise(setImmediate);
    assert.ok(JSON.parse(readFileSync(join(folder, 'state.json'), 'utf8')).pid, 'the heartbeat state is whole while it runs');
    stop.abort();
    assert.equal((await running).served, true);
    assert.equal(existsSync(join(folder, 'state.json')) || existsSync(join(folder, 'lock')), false);
  });

test('#8250 clause 1: a stop that lands while a receipt write is in flight lets that write finish before the runner exits [C7]', { timeout: 60_000 }, // budget: one local git checkout and one node child.
  async t => {
    const { root: trunk } = privateFixtureFiles('pullboard-idle-stop-trunk-');
    const { root: cache } = privateFixtureFiles('pullboard-idle-stop-held-');
    t.after(() => { rmSync(trunk, { recursive: true, force: true }); rmSync(cache, { recursive: true, force: true }); });
    const sh = (...args) => runFixtureGit(['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', ...args], { cwd: trunk });
    sh('init', '-q', '-b', 'main');
    writeFileSync(join(trunk, 'tracked.txt'), 'one\n');
    sh('add', '.');
    sh('commit', '-q', '-m', 'one');
    const commit = sh('rev-parse', 'HEAD');
    const stop = new AbortController(), log = [];
    let handed = 0;
    const fetchImpl = async (_url, { body }) => {
      const call = JSON.parse(body);
      if (call.action === 'claim') { handed += 1; return reply({ trunk, claim: handed > 1 ? null : { job: 'g1', attempt: 1, token: 't1', candidate: commit, base: commit, run: [] } }); }
      if (call.action === 'request') return reply({ request: { run: ['node', '-e', 'process.stdin.resume(); process.stdin.on("end", () => console.log("PULLBOARD_GATE_RECEIPT " + JSON.stringify({ version: 1, green: true })));'], input: { main: commit, entry: 'x', data: {} }, commits: [] } });
      if (call.action === 'receipt') {
        stop.abort();
        await new Promise(setImmediate);
        await new Promise(setImmediate);
        log.push('receipt written');
      }
      return reply({ ok: true, renewed: true });
    };
    const { jobs } = await serveRunner({ git: pullGit, board: BOARD, runner: 'r-held', capabilities: [], cache, jobs: 1, cores: 1, signal: stop.signal, fetchImpl });
    log.push('serve returned');
    assert.deepEqual(log, ['receipt written', 'serve returned']);
    assert.equal(jobs[0].outcome, 'posted');
  });
