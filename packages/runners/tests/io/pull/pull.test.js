/** Pull-mode runner scripts, status mirror and waiter, run through the ssh stand-in against a real runner folder [5465,5468,C7]. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateFixtureFiles } from '../../../../../apps/cli/tests/fixtures/child.js';
import { HOST } from '../../../../../apps/cli/tests/fixtures/runner/ssh.js';
import { installSshStandIn } from '../../../../../apps/cli/tests/fixtures/runner/ssh.js';
import { enqueueRunnerJob } from '../../../src/io/pull/enqueue.js';
import { fetchRunnerFile } from '../../../src/io/pull/enqueue.js';
import { uploadRunnerPack } from '../../../src/io/pull/enqueue.js';
import { readRunnerMirror } from '../../../src/io/pull/mirror.js';
import { refreshRunnerStatus } from '../../../src/io/pull/mirror.js';
import { ackRunnerJob } from '../../../src/io/pull/mirror.js';
import { requestRunnerCancel } from '../../../src/io/pull/mirror.js';
import { runRunnerScript } from '../../../src/io/pull/ssh.js';
import { enqueueScript } from '../../../src/io/pull/scripts.js';
import { waitRunnerJob } from '../../../src/io/pull/wait.js';

/** A runner root, a status folder and the ssh stand-in over them; `fail` swaps the stand-in for a command that always fails. */
function runnerFixture(t) {
  const base = privateFixtureFiles('pbpull-').root;
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'runner'), dir = join(base, 'status'), bin = join(base, 'bin'), requests = join(base, 'requests');
  for (const sub of [root, dir, bin, join(base, 'home')]) mkdirSync(sub, { recursive: true });
  const ssh = installSshStandIn({ bin, worker: base, home: join(base, 'home'), machineHome: join(base, 'machine'), requests });
  const runner = { host: HOST, root };
  const calls = () => (existsSync(requests) ? readFileSync(requests, 'utf8').split('\n').filter(line => line.includes('"workerStarted":true')).length : 0);
  /** Lay out one job folder as the runner agent would. */
  const job = (state, id, files = {}) => {
    const folder = join(root, state, id);
    mkdirSync(folder, { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(join(folder, name), text);
    return folder;
  };
  return { base, root, dir, runner, ssh, calls, job, mirror: { dir, ssh } };
}

const RESULT = id => `PULLBOARD_RUNNER_RESULT ${id} e30=\n`;

test('5468 clause 1: enqueue builds the whole row (row.json, frame, wanted) or none, and refuses a duplicate id [C7]', async t => {
  const f = runnerFixture(t);
  const frame = Buffer.from([0, 1, 2, 10, 255, 10, 7]);
  await enqueueRunnerJob(f.runner, { id: 'j-1', row: { recovery: { request: 'r' }, rawOutput: false }, frame }, { ssh: f.ssh, dir: f.dir });
  const folder = join(f.root, 'queue', 'j-1');
  assert.deepEqual(readFileSync(join(folder, 'frame')), frame);
  const row = JSON.parse(readFileSync(join(folder, 'row.json'), 'utf8'));
  assert.equal(row.version, 1);
  assert.equal(row.id, 'j-1');
  assert.equal(row.rawOutput, false);
  assert.ok(existsSync(join(folder, 'wanted')));
  assert.deepEqual(existsSync(join(f.root, 'queue', '.tmp-j-1')), false);
  await assert.rejects(enqueueRunnerJob(f.runner, { id: 'j-1', row: {}, frame }, { ssh: f.ssh, dir: f.dir }), error => error.code === 'RUNNER_PULL_SCRIPT' && error.status === 4);
});

test('5468 clause 1: a frame cut short is removed, never queued [C7]', async t => {
  const f = runnerFixture(t);
  const run = await runRunnerScript(f.runner, enqueueScript(f.runner, { id: 'cut', frameBytes: 100 }), { ssh: f.ssh, dir: f.dir, stdin: Buffer.from('{"id":"cut"}\nonly ten b') });
  assert.equal(run.status, 3);
  assert.equal(existsSync(join(f.root, 'queue', 'cut')), false);
  assert.equal(existsSync(join(f.root, 'queue', '.tmp-cut')), false);
});

test('5468 clause 1: an id that is not a plain folder name is refused before any script runs [C7]', () => {
  assert.throws(() => enqueueScript({}, { id: '../x', frameBytes: 1 }), /invalid pull job id/u);
  assert.throws(() => enqueueScript({}, { id: "a'; rm -rf /; '", frameBytes: 1 }), /invalid pull job id/u);
});

test('5468 clause 1: a source pack uploads into the job folder and marks it ready; files read back whole or by tail [C7]', async t => {
  const f = runnerFixture(t);
  const folder = f.job('running', 'p-1', { 'out.bin': '0123456789', 'control.log': 'a\nb\n' });
  const pack = join(f.base, 'x.pack');
  writeFileSync(pack, Buffer.from('PACK\0data'));
  await uploadRunnerPack(f.runner, { id: 'p-1', file: pack }, { ssh: f.ssh, dir: f.dir });
  assert.deepEqual(readFileSync(join(folder, 'source.pack')), Buffer.from('PACK\0data'));
  assert.ok(existsSync(join(folder, 'source.pack.ready')));
  assert.equal((await fetchRunnerFile(f.runner, { id: 'p-1', name: 'out.bin' }, { ssh: f.ssh, dir: f.dir })).toString(), '0123456789');
  assert.equal((await fetchRunnerFile(f.runner, { id: 'p-1', name: 'out.bin', tailBytes: 3 }, { ssh: f.ssh, dir: f.dir })).toString(), '789');
  await assert.rejects(fetchRunnerFile(f.runner, { id: 'nope', name: 'out.bin' }, { ssh: f.ssh, dir: f.dir }), error => error.status === 4);
});

test('5468 clause 1: the status script reports every job folder and applies wanted, cancel and ack lines from stdin [C7]', async t => {
  const f = runnerFixture(t);
  const dead = 2 ** 22 + 12345;
  f.job('queue', 'q1');
  f.job('running', 'r1', { 'control.log': `PULLBOARD_RUNNER_READY r1\nPULLBOARD_RUNNER_HEARTBEAT r1\n`, beat: '', 'owner.json': JSON.stringify({ pid: process.pid, startedAt: 1 }) });
  const old = new Date(Date.now() - 40_000);
  utimesSync(join(f.root, 'running', 'r1', 'beat'), old, old);
  f.job('running', 'r2', { 'control.log': 'PULLBOARD_RUNNER_NEED r2 QUJD\n', 'owner.json': JSON.stringify({ pid: dead }) });
  f.job('done', 'd1', { 'control.log': RESULT('d1'), exit: '{ "code": 0,\n "signal": null }' });
  f.job('done', 'd2', { exit: '{"code":null,"signal":"SIGTERM"}' });
  f.job('queue', '.tmp-half');
  requestRunnerCancel(HOST, 'q1', { dir: f.dir });
  ackRunnerJob(HOST, 'd2', { dir: f.dir });
  const { mirror, refreshed } = await refreshRunnerStatus(f.runner, f.mirror);
  assert.equal(refreshed, true);
  assert.equal(mirror.reachable, true);
  assert.deepEqual(Object.keys(mirror.jobs).sort(), ['d1', 'q1', 'r1', 'r2']);
  assert.equal(mirror.jobs.q1.state, 'queue');
  assert.ok(existsSync(join(f.root, 'queue', 'q1', 'cancel')), 'cancel line reached the job');
  assert.equal(existsSync(join(f.root, 'done', 'd2')), false, 'ack removed the finished folder');
  assert.equal(mirror.jobs.r1.ready, true);
  assert.equal(mirror.jobs.r1.alive, true);
  assert.ok(mirror.jobs.r1.beatAgeMs >= 40_000 && mirror.jobs.r1.beatAgeMs < 50_000);
  assert.equal(mirror.jobs.r2.alive, false);
  assert.equal(mirror.jobs.r2.need, 'QUJD');
  assert.equal(mirror.jobs.r2.beatAgeMs, null);
  assert.deepEqual(mirror.jobs.d1.exit, { code: 0, signal: null });
  assert.equal(mirror.jobs.d1.resultSeen, true);
  assert.equal(mirror.jobs.r1.resultSeen, false);
  assert.equal(mirror.agent, 'absent');
});

test('5468 clause 1: many waiters on one runner share one status refresh, and each learns its own job ended [C7]', async t => {
  const f = runnerFixture(t);
  const ids = Array.from({ length: 12 }, (_, index) => `w${index}`);
  for (const id of ids) f.job('done', id, { 'control.log': RESULT(id), exit: '{"code":0,"signal":null}' });
  const ends = await Promise.all(ids.map(id => waitRunnerJob({ runner: f.runner, id, tickMs: 30, mirror: f.mirror })));
  assert.deepEqual(ends.map(end => end.end), ids.map(() => 'result'));
  assert.ok(ends.every(end => end.finishReason === null && end.cancel === false));
  assert.equal(f.calls(), 1, 'twelve waiters, one ssh');
  assert.equal(readRunnerMirror(HOST, { dir: f.dir }).reachable, true);
});

test('5468 clause 1: a fresh mirror is not refreshed again inside 3 s, and a stale lock does not block a refresh [C7]', async t => {
  const f = runnerFixture(t);
  await refreshRunnerStatus(f.runner, f.mirror);
  const second = await refreshRunnerStatus(f.runner, f.mirror);
  assert.equal(second.refreshed, false);
  assert.equal(f.calls(), 1);
  const lock = join(f.dir, `${HOST}.lock`);
  writeFileSync(lock, '1');
  const held = await refreshRunnerStatus(f.runner, { ...f.mirror, force: true });
  assert.equal(held.refreshed, false, 'a live lock holds other refreshers off');
  const past = new Date(Date.now() - 60_000);
  utimesSync(lock, past, past);
  const taken = await refreshRunnerStatus(f.runner, { ...f.mirror, force: true });
  assert.equal(taken.refreshed, true, 'a lock older than 15 s is stale');
  assert.equal(existsSync(lock), false);
});

test('5468 clause 2: job end states map to the finish reasons the design lists [C7]', async t => {
  const f = runnerFixture(t);
  const wait = (id, extra = {}) => waitRunnerJob({ runner: f.runner, id, tickMs: 30, mirror: { ...f.mirror, intervalMs: 30 }, ...extra });
  f.job('done', 'ok', { 'control.log': RESULT('ok'), exit: '{"code":0,"signal":null}' });
  f.job('done', 'silent', { exit: '{"code":null,"signal":"SIGKILL"}' });
  f.job('done', 'rebooted', { exit: '{"code":null,"signal":"LOST"}' });
  f.job('running', 'orphan', { 'owner.json': JSON.stringify({ pid: 2 ** 22 + 999 }) });
  assert.deepEqual((({ end, finishReason, cancel }) => ({ end, finishReason, cancel }))(await wait('ok')), { end: 'result', finishReason: null, cancel: false });
  assert.deepEqual((({ end, finishReason }) => ({ end, finishReason }))(await wait('silent')), { end: 'ssh-exit', finishReason: 'ssh-exit' });
  assert.equal((await wait('rebooted')).finishReason, 'job-lost');
  assert.equal((await wait('orphan')).finishReason, 'job-lost');
  assert.equal((await wait('never-queued')).finishReason, 'job-lost');
});

test('5468 clause 2: no ready by the startup deadline cancels and ends as admission-deadline; the cancel reaches the job [C7]', async t => {
  const f = runnerFixture(t);
  f.job('queue', 'slow');
  const end = await waitRunnerJob({ runner: f.runner, id: 'slow', startupDeadline: Date.now() + 100, tickMs: 30, mirror: { ...f.mirror, intervalMs: 30 } });
  assert.deepEqual([end.end, end.finishReason, end.cancel], ['admission-deadline', 'admission-deadline', true]);
  await refreshRunnerStatus(f.runner, { ...f.mirror, force: true });
  assert.ok(existsSync(join(f.root, 'queue', 'slow', 'cancel')));
});

test('5468 clause 2: a ready job with no result past its ceiling is cancelled as run-timeout; ready is announced once [C7]', async t => {
  const f = runnerFixture(t);
  f.job('running', 'hang', { 'control.log': 'PULLBOARD_RUNNER_READY hang\n', 'owner.json': JSON.stringify({ pid: process.pid }), beat: '' });
  let ready = 0;
  const end = await waitRunnerJob({ runner: f.runner, id: 'hang', ceilingMs: 150, tickMs: 30, onReady: () => { ready++; }, mirror: { ...f.mirror, intervalMs: 30 } });
  assert.deepEqual([end.end, end.finishReason, end.cancel], ['run-timeout', 'run-timeout', true]);
  assert.equal(ready, 1);
  await refreshRunnerStatus(f.runner, { ...f.mirror, force: true });
  assert.ok(existsSync(join(f.root, 'running', 'hang', 'cancel')));
});

test('5468 clause 2: abort cancels as canceled, and an observe hit ends with the caller\'s own reason and error [C7]', async t => {
  const f = runnerFixture(t);
  f.job('queue', 'a');
  f.job('queue', 'b');
  const controller = new AbortController();
  const aborted = waitRunnerJob({ runner: f.runner, id: 'a', signal: controller.signal, tickMs: 30, mirror: { ...f.mirror, intervalMs: 30 } });
  setTimeout(() => controller.abort(), 80);
  const end = await aborted;
  assert.deepEqual([end.end, end.finishReason, end.cancel], ['canceled', 'canceled', true]);
  const failure = new Error('source moved');
  const hit = await waitRunnerJob({ runner: f.runner, id: 'b', tickMs: 30, mirror: { ...f.mirror, intervalMs: 30 }, observe: () => ({ end: 'source-changed', error: failure }) });
  assert.deepEqual([hit.end, hit.finishReason, hit.cancel, hit.error], ['source-changed', 'source-changed', true, failure]);
});

test('5468 clause 2: a runner that fails three refreshes is unreachable and ends as ssh-exit; a needed inventory is handed over once [C7]', async t => {
  const f = runnerFixture(t);
  f.job('queue', 'lost');
  const end = await waitRunnerJob({ runner: f.runner, id: 'lost', tickMs: 20, mirror: { dir: f.dir, ssh: '/usr/bin/false', intervalMs: 20 } });
  assert.deepEqual([end.end, end.finishReason, end.cancel], ['runner-unreachable', 'ssh-exit', false]);
  assert.equal(readRunnerMirror(HOST, { dir: f.dir }).failures >= 3, true);
  rmSync(join(f.dir, `${HOST}.json`));
  f.job('running', 'needy', { 'control.log': 'PULLBOARD_RUNNER_NEED needy QUJD\n', 'owner.json': JSON.stringify({ pid: process.pid }) });
  const needs = [];
  let handOver;
  const handed = new Promise(resolve => { handOver = resolve; });
  const controller = new AbortController();
  const done = waitRunnerJob({ runner: f.runner, id: 'needy', signal: controller.signal, tickMs: 20, mirror: { ...f.mirror, intervalMs: 20 }, onNeed: async (id, need) => { needs.push([id, need]); handOver(); } });
  await handed;
  controller.abort();
  await done;
  assert.deepEqual(needs, [['needy', 'QUJD']]);
});
