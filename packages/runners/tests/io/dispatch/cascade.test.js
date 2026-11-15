/** A runner already unavailable is not quarantined again by its own jobs' cleanup: one drop is one quarantine [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { takeResource } from '../../../../resources/index.js';
import { recordRunnerFailure } from '../../../../resources/index.js';
import { runnerUnavailableRefusal } from '../../../src/io/dispatch.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';

const RUNNERS = [{ host: 'fixture-a', slots: 2, browser: 0 }, { host: 'fixture-b', slots: 2, browser: 0 }];

/** Own a private machine pool whose two runners reach admission through each request's runnerProvider. */
function machine(t) {
  const { root: directory } = privateFixtureFiles('pullboard-no-cascade-');
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(directory, 'machine');
  mkdirSync(process.env.PULLBOARD_MACHINE_HOME);
  t.after(() => {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, pool: join(process.env.PULLBOARD_MACHINE_HOME, 'resources.sqlite') };
}

/** A runner-only gate lease as gate-slot takes one for a submit, held at once with no wait. */
function gateOptions(box) {
  return { name: 'gate', scope: 'machine', root: box.directory, repo: box.directory, capacity: 0, browserCapacityProvider: () => 0,
    browser: false, gui: false, itemCheck: true, infrastructureRetry: true, agent: 'core-1', item: '3698', kind: 'submit',
    runnerOnly: true, remote: true, runnerWaitMs: 10_000, runnerDeadlineAt: Date.now() + 10_000, runnerProvider: () => RUNNERS,
    onWait() { throw new Error('a free runner slot exists; the lease must not queue'); } };
}

/** One job's exact recovery identity, as the runner request carries it. */
const recovery = n => ({ version: 1, launchFence: 1, request: `0000000${n}-0000-4000-8000-000000000000`, nonce: `1111111${n}-0000-4000-8000-000000000000`, tooling: 'f'.repeat(64) });

/** The runner's unavailable events and its quarantine row, read from the real pool. */
function observe(pool, host) {
  const db = new DatabaseSync(pool, { readOnly: true });
  try {
    return { events: db.prepare("SELECT detail FROM runner_recovery_event WHERE host=? AND kind='unavailable'").all(host).map(row => JSON.parse(row.detail)),
      row: db.prepare('SELECT since, detail, probe_after, probe_token, probe_until, probe_attempts, failure FROM runner_unavailable WHERE host=?').get(host) };
  } finally { db.close(); }
}

test('clause 1: a cleanup-unverified job whose runner was already unavailable writes no second unavailable event and keeps the idle proof running [C7]', { timeout: 30_000 }, async t => {
  const box = machine(t);
  const leases = [await takeResource(gateOptions(box)), await takeResource(gateOptions(box))];
  const onA = leases.filter(lease => lease.runner.host === 'fixture-a');
  assert.ok(onA.length >= 1, 'a job holds fixture-a when it drops');
  const host = 'fixture-a';
  // The drop: fixture-a's own failure quarantines it once.
  const db = new DatabaseSync(box.pool);
  try { recordRunnerFailure(db, host, 'transport-lost', { reason: 'completion unavailable', recovery: recovery(1) }); }
  finally { db.close(); }
  const dropped = observe(box.pool, host);
  assert.equal(dropped.events.length, 1, 'the drop is one quarantine');
  // Each job waiting on fixture-a sees it unavailable before READY; runner-dispatch refuses it, and the gate requeues it as cleanup-unverified.
  const replacements = [];
  for (const [index, lease] of onA.entries()) {
    const refusal = runnerUnavailableRefusal({ runner: { host }, spec: { id: `job-${index}`, recovery: recovery(index + 2) }, phase: 'connect', args: [] },
      { host, reason: 'TRANSPORT_UNVERIFIED' });
    assert.equal(refusal.code, 'RUNNER_UNAVAILABLE');
    assert.equal(refusal.diagnostic.reason, 'runner-unavailable');
    replacements.push(await lease.requeueRunner('cleanup-unverified', { quarantine: true, diagnostic: { ...refusal.diagnostic, confirmingProbe: null } }));
  }
  try {
    const after = observe(box.pool, host);
    assert.equal(after.events.length, 1, `fixture-a still has one unavailable event after ${onA.length} of its jobs' cleanups`);
    for (const key of ['since', 'detail', 'probe_after', 'probe_token', 'probe_until', 'probe_attempts']) {
      assert.equal(after.row[key], dropped.row[key], `the quarantine's ${key} is unchanged, so its idle proof is not restarted`);
    }
    assert.deepEqual(JSON.parse(after.row.failure).pending.map(entry => entry.request),
      [recovery(1), ...onA.map((_, index) => recovery(index + 2))].map(entry => entry.request), 'each job joins the proof\'s pending cleanups');
    assert.deepEqual(replacements.map(lease => lease.runner.host), onA.map(() => 'fixture-b'), 'each requeued job runs on the healthy runner');
  } finally { for (const lease of [...replacements, ...leases.filter(lease => !onA.includes(lease))]) lease.release(); }
});

test('clause 1: the same cleanup on a runner that is not unavailable still quarantines it, and other cleanups still record [C7]', async t => {
  const box = machine(t);
  (await takeResource(gateOptions(box))).release();
  const db = new DatabaseSync(box.pool);
  try {
    const refusal = runnerUnavailableRefusal({ runner: { host: 'fixture-b' }, spec: { id: 'job-9', recovery: recovery(9) }, phase: 'connect', args: [] }, { host: 'fixture-b', reason: 'TRANSPORT_UNVERIFIED' });
    recordRunnerFailure(db, 'fixture-b', 'cleanup-unverified', refusal.diagnostic);
    recordRunnerFailure(db, 'fixture-b', 'cleanup-unverified', { reason: 'cleanup-unverified', recovery: recovery(8) });
  } finally { db.close(); }
  const { events, row } = observe(box.pool, 'fixture-b');
  assert.equal(events.length, 2, 'a first runner-unavailable cleanup quarantines, and a real cleanup timeout on an out runner still records');
  assert.equal(row.detail, 'CLEANUP_UNVERIFIED');
});

test('clause 2: a reproduction of one runner drop with eight waiting jobs writes one unavailable event after the fix, against nine before [C7]', { timeout: 30_000 }, async t => {
  const box = machine(t);
  (await takeResource(gateOptions(box))).release();
  const jobs = 8;
  const db = new DatabaseSync(box.pool);
  try {
    // Before the fix every cleanup of a job on a runner already out wrote its own event: a cleanup whose recorded reason is not runner-unavailable takes that path, so it stands in for the old behaviour.
    // After the fix the same cleanups carry the runner-unavailable reason runner-dispatch gives them.
    for (const [host, standIn] of [['fixture-a', true], ['fixture-b', false]]) {
      recordRunnerFailure(db, host, 'transport-lost', { reason: 'completion unavailable', recovery: recovery(1) });
      for (let n = 0; n < jobs; n++) {
        const refusal = runnerUnavailableRefusal({ runner: { host }, spec: { id: `job-${n}`, recovery: recovery(n + 2) }, phase: 'connect', args: [] }, { host, reason: 'TRANSPORT_UNVERIFIED' });
        recordRunnerFailure(db, host, 'cleanup-unverified', standIn ? { ...refusal.diagnostic, reason: 'cleanup-unverified' } : refusal.diagnostic);
      }
    }
  } finally { db.close(); }
  const before = observe(box.pool, 'fixture-a').events.length;
  const after = observe(box.pool, 'fixture-b').events.length;
  t.diagnostic(`unavailable events for one drop with ${jobs} waiting jobs: before ${before}, after ${after}`);
  console.log(`MEASURED reproduction: unavailable events for one drop with ${jobs} waiting jobs: before ${before}, after ${after}`);
  assert.equal(after, 1, 'after the fix one drop is one unavailable event');
  assert.ok(before > after, `before the fix the same drop wrote ${before} events`);
});
