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

/**
 * A board that answers each claim from a queue and refuses the receipt of `refuse` jobs with `code`; every call is kept.
 * @param {string[]} jobs
 * @param {Record<string, string>} refuse - Job id to the refusal code its receipt call answers.
 */
function refusingBoard(jobs, refuse) {
  const open = [...jobs], calls = [];
  const fetchImpl = async (_url, { body }) => {
    const call = JSON.parse(body);
    calls.push(call);
    queueMicrotask(changed);
    if (call.action === 'claim') {
      const job = open.shift();
      const claim = job === undefined ? null : { job, kind: 'gate', needs: [], run: [], candidate: null, base: null, attempt: 1, token: 't' };
      return { status: 200, json: async () => ({ trunk: 'unused', claim }) };
    }
    if (call.action === 'receipt' && refuse[call.job]) return { status: 400, json: async () => ({ error: { code: refuse[call.job], message: `refused ${call.job}` } }) };
    return { status: 200, json: async () => (call.action === 'renew' ? { renewed: true } : { recorded: true }) };
  };
  return { fetchImpl, calls };
}

/** Serves one board with two slots until the test aborts; `hold` names a job whose handler waits for release(). */
function serveRefusing(t, queue, hold) {
  const { root } = privateFixtureFiles('pullboard-serve-refusal-');
  const stop = new AbortController(), gates = new Map(), posted = [];
  const handlers = { gate: async claim => { if (claim.job === hold) await new Promise(resolve => gates.set(claim.job, resolve)); posted.push(claim.job); changed(); return { outcome: 'green' }; } };
  const state = { returned: false };
  const serve = serveRunner({ git: pullGit, board: 'http://board.invalid/api/v1/boards/b0?k=x', runner: 'refusal-0', capabilities: [], cache: `${root}/b0`, jobs: 2,
    fetchImpl: queue.fetchImpl, handlers, signal: stop.signal, timing: { idleMs: 5 }, trunkPack: async () => {} }).finally(() => { state.returned = true; });
  t.after(() => { stop.abort(); rmSync(root, { recursive: true, force: true }); });
  return { stop, serve, state, posted, release: job => gates.get(job)?.() };
}

for (const code of ['JOB_RECEIPT', 'JOB_WRITE_TIMEOUT', 'HOP_FENCED', 'BOARD_BUSY', 'HOP_HELD']) {
  const id = code.toLowerCase().replace(/_/gu, '-');
  test(`drive.io-serve-refusal.${id}: clause 1: a ${code} refusal on one job's receipt releases that job, and the serve keeps its other slot running and claims again [C7]`, { timeout: 30_000 }, async t => {
    const queue = refusingBoard(['gate:1:hold', 'gate:2:refused', 'gate:3:after'], { 'gate:2:refused': code });
    const { stop, serve, state, posted, release } = serveRefusing(t, queue, 'gate:1:hold');
    await until(() => posted.includes('gate:3:after') && queue.calls.some(call => call.action === 'release' && call.job === 'gate:2:refused'));
    const released = queue.calls.find(call => call.action === 'release' && call.job === 'gate:2:refused');
    assert.match(released.reason, new RegExp(`\\[${code}\\]`, 'u'), 'the release names the refusal');
    assert.equal(state.returned, false, 'the serve did not return on the refusal');
    assert.ok(!posted.includes('gate:1:hold'), 'the other slot is still running its job');
    release('gate:1:hold');
    await until(() => posted.includes('gate:1:hold'));
    stop.abort();
    const result = await serve;
    assert.ok(result.jobs.some(job => job.job === 'gate:2:refused' && job.outcome === 'released'), 'the refused job is recorded as released');
  });
}

test('drive.io-serve-refusal.succeeding-job-calls: clause 3: a succeeding job makes one claim and one receipt call, the board calls it made before the change [C7]', { timeout: 30_000 }, async t => {
  const queue = refusingBoard(['gate:1:ok'], {});
  const { stop, serve, posted } = serveRefusing(t, queue, null);
  await until(() => posted.includes('gate:1:ok') && queue.calls.some(call => call.action === 'receipt'));
  stop.abort();
  await serve;
  const own = queue.calls.filter(call => call.job === 'gate:1:ok');
  assert.deepEqual(own.map(call => call.action), ['receipt'], 'a succeeding job adds only its receipt call to the claim');
  assert.equal(queue.calls.filter(call => call.action === 'release').length, 0, 'nothing is released');
});

test('drive.io-claim-key.one-key-per-claim-reused-on-retry: clause 1: queueCall sends one claim key per claim and the same key on each retry of that claim, and a new claim gets a new key [C7]', { timeout: 30_000 }, async t => {
  const claims = [];
  const fetchImpl = async (_url, { body }) => {
    const call = JSON.parse(body);
    if (call.action !== 'claim') return { status: 200, json: async () => ({ recorded: true }) };
    claims.push(call);
    if (claims.length <= 2) return { status: 503, json: async () => ({}) };
    queueMicrotask(changed);
    return { status: 200, json: async () => ({ trunk: 'unused', claim: null }) };
  };
  const { root } = privateFixtureFiles('pullboard-claim-key-');
  const stop = new AbortController();
  const serve = serveRunner({ git: pullGit, board: 'http://board.invalid/api/v1/boards/b0?k=x', runner: 'key-0', capabilities: [], cache: `${root}/b0`, jobs: 1,
    fetchImpl, handlers: {}, signal: stop.signal, timing: { idleMs: 5, firstMs: 1, maxMs: 2 }, trunkPack: async () => {} });
  t.after(() => { stop.abort(); rmSync(root, { recursive: true, force: true }); });
  await until(() => claims.length >= 4);
  stop.abort();
  await serve;
  assert.match(claims[0].key, /^[A-Za-z0-9_-]{8,128}$/u, 'the claim carries a plain random key');
  assert.equal(claims[1].key, claims[0].key, 'the first retry sends the same key');
  assert.equal(claims[2].key, claims[0].key, 'the second retry sends the same key');
  assert.notEqual(claims[3].key, claims[0].key, 'the next claim gets a new key');
});

/** A board offering `count` gate jobs, each with its own token, that keeps every renew call body. */
function renewBoard(count) {
  const open = Array.from({ length: count }, (_, at) => ({ job: `gate:${at}:r`, kind: 'gate', needs: [], run: [], candidate: null, base: null, attempt: 1, token: `t${at}` })), renews = [];
  const fetchImpl = async (_url, { body }) => {
    const call = JSON.parse(body);
    if (call.action === 'claim') { queueMicrotask(changed); return { status: 200, json: async () => ({ trunk: 'unused', claim: open.shift() ?? null }) }; }
    if (call.action === 'renew') { renews.push(call); queueMicrotask(changed); return { status: 200, json: async () => ({ leases: (call.held ?? []).map(({ job }) => ({ job, renewed: true, leaseUntil: 1 })) }) }; }
    return { status: 200, json: async () => ({ recorded: true }) };
  };
  return { fetchImpl, renews };
}

test('drive.io-keep-lease.one-renew-for-all-held: clause 1: with 10 held jobs keepLease sends one renew call per interval carrying all 10 job ids [C7,#12150]', { timeout: 30_000 }, async t => {
  const queue = renewBoard(10), jobs = holders();
  const { root } = privateFixtureFiles('pullboard-pull-renew-');
  const stop = new AbortController();
  const serving = serveRunner({ git: pullGit, board: 'http://board.invalid/api/v1/boards/b0?k=x', runner: 'renew-0', capabilities: [], cache: `${root}/b0`, jobs: 10,
    fetchImpl: queue.fetchImpl, handlers: jobs.handlers, signal: stop.signal, timing: { renewMs: 20, idleMs: 5 }, trunkPack: async () => {} });
  t.after(() => { stop.abort(); rmSync(root, { recursive: true, force: true }); });
  await until(() => jobs.started.length === 10);
  const from = queue.renews.length;
  await until(() => queue.renews.length >= from + 3);
  const interval = queue.renews.slice(from, from + 3);
  assert.ok(interval.every(call => call.job === undefined && call.runner === 'renew-0'), 'every renew is the runner\'s batch call, not a call per job');
  assert.ok(interval.every(call => call.held.length === 10 && new Set(call.held.map(entry => entry.job)).size === 10), 'each carries all 10 held job ids');
  assert.ok(interval.every(call => call.held.every(entry => entry.token === `t${entry.job.split(':')[1]}`)), 'each job with its own token');
  for (const job of [...jobs.started]) jobs.release(job);
  stop.abort();
  await serving;
});

test('drive.io-keep-lease.capped-claim-waits: clause 1: a claim answer carrying a wait time makes serveRunner wait that time instead of its idle poll [C7,#12150]', { timeout: 30_000 }, async t => {
  const claims = [], slept = [];
  const fetchImpl = async (_url, { body }) => {
    const call = JSON.parse(body);
    if (call.action === 'claim') { claims.push(call); queueMicrotask(changed); return { status: 200, json: async () => ({ trunk: 'unused', claim: null, waitMs: 300 }) }; }
    return { status: 200, json: async () => ({ recorded: true }) };
  };
  const { root } = privateFixtureFiles('pullboard-pull-capped-');
  const stop = new AbortController();
  const serving = serveRunner({ git: pullGit, board: 'http://board.invalid/api/v1/boards/b0?k=x', runner: 'capped-0', capabilities: [], cache: `${root}/b0`, jobs: 1,
    fetchImpl, handlers: {}, signal: stop.signal, timing: { idleMs: 5 }, trunkPack: async () => {},
    sleep: ms => { slept.push(ms); return new Promise(resolve => setImmediate(resolve)); } });
  t.after(() => { stop.abort(); rmSync(root, { recursive: true, force: true }); });
  await until(() => claims.length >= 3);
  stop.abort();
  await serving;
  assert.ok(slept.includes(300), 'the runner waited the 300 ms the claim answer carried');
  assert.ok(!slept.includes(5), 'and never the 5 ms idle poll');
});
