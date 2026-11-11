/** The remote worker synchronizes its persisted pool to the board's per-job registration [C7]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as resources from '../../../../../../../packages/resources/index.js';
import { registeredCapacity } from '../../../../../index.js';

/** Give this test a private machine resource database and restore the caller's environment. */
function privateMachine(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-runner-capacity-sync-'));
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

/** Release every acquired lease even when a capacity assertion fails. */
function releaseAll(leases) {
  for (const lease of leases.reverse()) lease.release();
}

test('a live old pool resizes to registered limits with queued work and admits within the new count [C7]', { timeout: 15_000 }, async t => {
  const root = privateMachine(t), leases = [];
  let allowRemote = false;
  let queuedResolve;
  let queueTimer;
  const queued = new Promise(resolve => { queuedResolve = resolve; });
  let remoteWaiter;
  try {
    writeFileSync(join(root, 'settings.json'), '{"gateSlots":14,"browserSlots":10}\n');
    const settingsBefore = readFileSync(join(root, 'settings.json'));
    for (const [index, browser] of [true, true, false, false].entries()) {
      leases.push(await resources.takeResource({ name: 'gate', capacity: 14, scope: 'machine', root, browser,
        browserCapacityProvider: () => 10, agent: `old-pool-${index + 1}` }));
    }
    remoteWaiter = resources.takeResource({ name: 'gate', capacity: 14, scope: 'machine', root, remote: true, runnerOnly: true,
      runnerProvider: () => allowRemote ? [{ host: 'fixture-runner', slots: 9, browser: 3 }] : [], agent: 'queued-runner-job',
      onWait: state => { if (state.line.some(row => row.agent === 'queued-runner-job')) queuedResolve(); } })
      .then(lease => ({ lease }), error => ({ error }));
    await Promise.race([queued, new Promise((_, reject) => {
      queueTimer = setTimeout(() => reject(new Error('the fixture runner waiter did not enter the queue')), 10_000); // budget: hang ceiling for native waiter visibility; leaves 5s of 15s for owned cleanup.
    })]);
    clearTimeout(queueTimer);

    assert.throws(() => resources.setResourceCapacity({ name: 'gate', capacity: 9, scope: 'machine', root }), error => {
      assert.equal(error.code, 'RESOURCE_BUSY');
      assert.match(error.message, /capacity 14/u);
      assert.match(error.message, /changing capacity 14 to 9 waits for an empty queue/u);
      return true;
    }, 'ordinary capacity changes keep their existing empty-queue rule');

    assert.deepEqual(registeredCapacity(resources, { slots: 9, browser: 3 }, root, root), {
      gateCapacity: 9,
      browserCapacity: 3,
    });
    const rows = resources.listResources({ scope: 'machine', root });
    assert.equal(rows.find(row => row.name === 'gate').capacity, 9, 'the worker pool now matches the board registration');
    assert.equal(rows.find(row => row.name === 'browser').capacity, 3, 'browser capacity follows the same registration');
    assert.equal(rows.find(row => row.name === 'gate').holders.length, 4, 'resizing keeps existing leases intact');
    assert.equal(rows.find(row => row.name === 'browser').holders.length, 2, 'the browser pool counts only browser-marked gate holders');
    assert.ok(rows.find(row => row.name === 'gate').line.some(row => row.agent === 'queued-runner-job'), 'an existing waiter remains queued');
    assert.deepEqual(readFileSync(join(root, 'settings.json')), settingsBefore, 'worker synchronization does not rewrite machine settings');

    const withinRegisteredLimit = await resources.takeResource({ name: 'gate', capacity: 9, scope: 'machine', root,
      browser: true, browserCapacityProvider: () => 3, agent: 'registered-limit-job' });
    leases.push(withinRegisteredLimit);
    const admitted = resources.listResources({ scope: 'machine', root });
    assert.equal(admitted.find(row => row.name === 'gate').holders.length, 5,
      'the worker admits a job below the registered limit while earlier jobs continue');
    assert.equal(admitted.find(row => row.name === 'browser').holders.length, 3,
      'the browser job is admitted below its registered limit');
    allowRemote = true;
    const outcome = await remoteWaiter;
    assert.ifError(outcome.error);
    leases.push(outcome.lease);
  } finally {
    clearTimeout(queueTimer);
    if (remoteWaiter) {
      allowRemote = true;
      const outcome = await remoteWaiter;
      if (outcome.lease && !leases.includes(outcome.lease)) leases.push(outcome.lease);
    }
    releaseAll(leases);
  }
});

test('a browser registration below browser-marked holders is refused without changing the gate or browser pool [C7]', async t => {
  const root = privateMachine(t), leases = [];
  try {
    for (const [index, browser] of [true, true, false, false].entries()) {
      leases.push(await resources.takeResource({ name: 'gate', capacity: 4, scope: 'machine', root, browser,
        browserCapacityProvider: () => 4, agent: `browser-bound-${index + 1}` }));
    }
    assert.throws(() => registeredCapacity(resources, { slots: 4, browser: 1 }, root, root), error => {
      assert.equal(error.code, 'RUNNER_CAPACITY_BUSY');
      assert.match(error.message, /registered with 1 browser slot/u);
      assert.match(error.message, /capacity 4; requested capacity 1/u);
      assert.match(error.message, /2 active holder/u);
      return true;
    });
    const rows = resources.listResources({ scope: 'machine', root });
    assert.equal(rows.find(row => row.name === 'gate').capacity, 4, 'the gate capacity stays at its registered value');
    assert.equal(rows.find(row => row.name === 'gate').holders.length, 4, 'the refusal retains every gate holder');
    assert.equal(rows.find(row => row.name === 'browser').capacity, 4, 'the browser pool keeps its old capacity');
    assert.equal(rows.find(row => row.name === 'browser').holders.length, 2, 'only browser-marked holders count against browser capacity');
  } finally { releaseAll(leases); }
});

test('a registered limit below active holders is refused with both capacities [C7]', async t => {
  const root = privateMachine(t), leases = [];
  try {
    for (const agent of ['over-limit-one', 'over-limit-two', 'over-limit-three', 'over-limit-four']) {
      leases.push(await resources.takeResource({ name: 'gate', capacity: 4, scope: 'machine', root, agent }));
    }
    assert.throws(() => registeredCapacity(resources, { slots: 3, browser: 2 }, root, root), error => {
      assert.equal(error.code, 'RUNNER_CAPACITY_BUSY');
      assert.match(error.message, /registered with 3 gate slot/u);
      assert.match(error.message, /capacity 4; requested capacity 3/u);
      return true;
    });
    assert.equal(resources.listResources({ scope: 'machine', root }).find(row => row.name === 'gate').capacity, 4,
      'the refusal does not lower capacity beneath running holders');
  } finally { releaseAll(leases); }
});
