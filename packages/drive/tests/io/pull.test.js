/** The machine's local runner holds one check-baseline job at a time across every board it serves, and other kinds keep the load-share admission [C7,#10794]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { heldKinds } from '../../index.js';
import { localLoadAdmits } from '../../index.js';
import { serveRunner } from '../../index.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';

// Handled kinds run in this process, so the runner's git is never asked for anything.
const pullGit = async () => ({ status: 0, stdout: '', stderr: '' });

/**
 * One board's queue behind a fake board API: claim honors `except` as the board's claimJob does, and every claim body is kept.
 * @param {Array<{ job: string, kind: string }>} rows
 */
function board(rows) {
  const open = [...rows], claims = [];
  const fetchImpl = async (_url, { body }) => {
    const call = JSON.parse(body);
    if (call.action === 'claim') {
      claims.push(call);
      queueMicrotask(changed);
      const at = open.findIndex(row => !(call.except ?? []).includes(row.kind));
      const claim = at < 0 ? null : { ...open.splice(at, 1)[0], needs: [], run: [], candidate: null, base: null, attempt: 1, token: 't' };
      return { status: 200, json: async () => ({ trunk: 'unused', claim }) };
    }
    return { status: 200, json: async () => (call.action === 'renew' ? { renewed: true } : { recorded: true }) };
  };
  return { fetchImpl, claims, open };
}

/** Handlers that hold each job until the test lets it go, recording which jobs started. */
function holders() {
  const started = [], gates = new Map();
  const hold = async claim => { started.push(claim.job); changed(); await new Promise(resolve => gates.set(claim.job, resolve)); return { outcome: 'green' }; };
  return { started, release: job => gates.get(job)?.(), handlers: { 'check-baseline': hold, gate: hold } };
}

/** Waits that end on the fake board's and handlers' own events, never on a timer. */
const waits = [];
const changed = () => { for (const wait of [...waits]) if (wait.check()) { waits.splice(waits.indexOf(wait), 1); wait.resolve(); } };
const until = check => new Promise(resolve => { waits.push({ check, resolve }); changed(); });

/** The local runner's two board serves on one machine ledger, admitting through localLoadAdmits at a share no load reaches. */
function machine(t, boards, handlers) {
  const { root } = privateFixtureFiles('pullboard-pull-baseline-');
  const stop = new AbortController();
  const ledger = heldKinds();
  const admit = ({ running, held }) => localLoadAdmits({ load: 0, cores: 8, share: 1_000, running, held });
  const serves = boards.map((queue, at) => serveRunner({ git: pullGit, board: `http://board.invalid/api/v1/boards/b${at}?k=x`, runner: `local-${at}`, capabilities: [],
    cache: `${root}/b${at}`, jobs: 1, fetchImpl: queue.fetchImpl, handlers, admit, ledger, signal: stop.signal, timing: { idleMs: 5 }, trunkPack: async () => {} }));
  t.after(async () => { stop.abort(); rmSync(root, { recursive: true, force: true }); });
  return { stop, ledger, serves };
}

test('drive.pull.c-10794-clause-1-one-baseline: clause 1: a machine\'s local runner holding one check-baseline job does not take a second check-baseline job, whatever gate.localLoadShare allows, through localLoadAdmits [C7,#10794]', { timeout: 30_000 }, async t => {
  assert.deepEqual(localLoadAdmits({ load: 0, cores: 8, share: 1_000, running: 0, held: ['check-baseline'] }), { except: ['check-baseline'] }, 'a held baseline is excepted even with no job running');
  assert.deepEqual(localLoadAdmits({ load: 0, cores: 8, share: 1_000, running: 1, held: ['gate', 'check-baseline'] }), { except: ['check-baseline'] }, 'and at any share the load allows');
  const first = board([{ job: 'baseline:1:a', kind: 'check-baseline' }]);
  const second = board([{ job: 'baseline:2:b', kind: 'check-baseline' }]);
  const jobs = holders();
  const { stop, serves } = machine(t, [first, second], jobs.handlers);
  await until(() => jobs.started.length === 1);
  const holding = jobs.started[0];
  const before = (holding === 'baseline:1:a' ? second : first).claims.length;
  await until(() => (holding === 'baseline:1:a' ? second : first).claims.length >= before + 3);
  assert.deepEqual(jobs.started, [holding], 'no second baseline started while one is held');
  const other = holding === 'baseline:1:a' ? second : first;
  assert.ok(other.claims.slice(before).every(call => call.except?.includes('check-baseline')), 'every claim while a baseline is held skips check-baseline');
  assert.equal(other.open.length, 1, 'the second baseline still waits in its queue');
  jobs.release(holding);
  await until(() => jobs.started.length === 2);
  jobs.release(jobs.started[1]);
  stop.abort();
  await Promise.all(serves);
});

test('drive.pull.c-10794-clause-2-other-kinds: clause 2: other job kinds keep today\'s load-share admission, and a gate is still taken while a baseline is held [C7,#10794]', { timeout: 30_000 }, async t => {
  assert.equal(localLoadAdmits({ load: 3, cores: 8, share: 1, running: 1, held: ['gate'] }), true, 'under the share a runner holding a gate takes another job');
  assert.equal(localLoadAdmits({ load: 9, cores: 8, share: 1, running: 1, held: ['gate'] }), false, 'over the share it waits');
  assert.equal(localLoadAdmits({ load: 90, cores: 8, share: 1, running: 0, held: [] }), true, 'a runner with no job takes one at any load');
  assert.equal(localLoadAdmits({ load: 9, cores: 8, share: 1, running: 1, held: ['check-baseline'] }), false, 'over the share a held baseline waits like any job');
  const first = board([{ job: 'baseline:1:a', kind: 'check-baseline' }]);
  const second = board([{ job: 'gate:2:c', kind: 'gate' }, { job: 'baseline:2:b', kind: 'check-baseline' }]);
  const jobs = holders();
  const { stop, serves } = machine(t, [first, second], jobs.handlers);
  await until(() => jobs.started.length === 2);
  assert.equal(jobs.started.filter(job => job.startsWith('baseline:')).length, 1, 'one baseline runs');
  assert.ok(jobs.started.includes('gate:2:c'), 'the gate was taken beside the held baseline');
  for (const job of [...jobs.started]) jobs.release(job);
  await until(() => jobs.started.length === 3);
  jobs.release(jobs.started[2]);
  stop.abort();
  await Promise.all(serves);
});
