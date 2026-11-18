/** Scoped machine-lease inheritance checks [Q1,Q2,Q3]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import {
  BROWSER_SLOT_HELD_ENV,
  GATE_SLOT_HELD_ENV,
  GATE_SLOT_POOL_ENV,
  GATE_SLOT_TOKEN_ENV,
  gateSlotEnvironment,
  inheritedGateSlot,
  listResources,
  takeResource,
} from '../../../src/io/main.js';

const TEMP = [];

/** Remove every private machine pool after its test releases its lease. */
function removeTemporaryPools() {
  for (const path of TEMP) rmSync(path, { recursive: true, force: true });
}

after(removeTemporaryPools);

/** Make a private machine-home directory for one lease test. */
function machinePool() {
  const path = mkdtempSync(join(tmpdir(), 'pullboard-resource-inheritance-'));
  TEMP.push(path);
  return path;
}

/** Apply environment values only for a synchronous operation, then restore them immediately. */
function withEnvironment(values, action) {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { return action(); }
  finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Acquire a machine gate lease while restoring the caller's machine-home override before awaiting it. */
function acquireGate(home, browser = false) {
  return withEnvironment({ PULLBOARD_MACHINE_HOME: home }, () => takeResource({
    name: 'gate', capacity: 1, browser, root: process.cwd(), agent: `inheritance-${browser ? 'browser' : 'gate'}`,
  }));
}

/** Read one private resource snapshot without retaining its machine-home override. */
function resourcesAt(home) {
  return withEnvironment({ PULLBOARD_MACHINE_HOME: home }, () => listResources());
}

/** Prove a child reuses the exact live lease at capacity one without consuming another slot. */
test('resources.inheritance.a-same-pool-child-reuses-the: a same-pool child reuses the live gate lease without taking another slot [Q1,Q2,Q3]', async () => {
  const home = machinePool();
  const lease = await acquireGate(home);
  try {
    const markers = gateSlotEnvironment(lease);
    assert.equal(markers[GATE_SLOT_HELD_ENV], '1');
    assert.equal(markers[GATE_SLOT_POOL_ENV], realpathSync(join(home, 'resources.sqlite')));
    assert.equal(markers[GATE_SLOT_TOKEN_ENV], lease.token);
    assert.equal(markers[BROWSER_SLOT_HELD_ENV], '');
    const reused = withEnvironment({ PULLBOARD_MACHINE_HOME: home, ...markers }, () => inheritedGateSlot({ root: process.cwd() }));
    assert.deepEqual({ name: reused.name, scope: reused.scope, pool: reused.pool, token: reused.token, browser: reused.browser, waitMs: reused.waitMs }, {
      name: 'gate', scope: 'machine', pool: lease.pool, token: lease.token, browser: false, waitMs: 0,
    });
    reused.release();
    assert.equal(resourcesAt(home)[0].holders.length, 1, 'the child release is inert and leaves the parent lease alive');
  } finally { lease.release(); }
});

/** Prove a symlinked machine-home path reuses the exact live database lease at capacity one. */
test('resources.inheritance.a-symlink-alias-to-the-same: a symlink alias to the same machine pool reuses its live gate lease [Q1,Q2,Q3]', async () => {
  const realHome = machinePool();
  const aliasParent = machinePool();
  const aliasHome = join(aliasParent, 'machine-home');
  symlinkSync(realHome, aliasHome, 'dir');
  const lease = await acquireGate(realHome);
  try {
    const markers = gateSlotEnvironment(lease);
    const reused = withEnvironment({ PULLBOARD_MACHINE_HOME: aliasHome, ...markers }, () => inheritedGateSlot({ root: process.cwd() }));
    assert.ok(reused, 'the symlink spelling identifies the live parent pool');
    assert.equal(lease.pool, realpathSync(join(realHome, 'resources.sqlite')));
    assert.equal(reused.token, lease.token, 'the aliased child reuses the parent token rather than joining its own queue');
    assert.equal(reused.pool, lease.pool, 'both spellings identify the same canonical database file');
    reused.release();
    assert.equal(resourcesAt(realHome).find((resource) => resource.name === 'gate').holders.length, 1, 'the child release leaves the parent lease alive');
  } finally { lease.release(); }
});

/** Prove a marker scoped to another machine database is ignored and does not suppress local acquisition. */
test('resources.inheritance.foreign-pool-markers-are-ignored-and: foreign-pool markers are ignored and the child acquires from its own pool [Q1,Q2,Q3]', async () => {
  const parentHome = machinePool();
  const childHome = machinePool();
  const parentLease = await acquireGate(parentHome);
  let childLease;
  try {
    const markers = gateSlotEnvironment(parentLease);
    const inherited = withEnvironment({ PULLBOARD_MACHINE_HOME: childHome, ...markers }, () => inheritedGateSlot({ root: process.cwd() }));
    assert.equal(inherited, null, 'a token belonging to another resolved machine database is not reused');
    childLease = await withEnvironment({ PULLBOARD_MACHINE_HOME: childHome, ...markers }, () => takeResource({
      name: 'gate', capacity: 1, root: process.cwd(), agent: 'foreign-pool-independent',
    }));
    assert.notEqual(childLease.pool, parentLease.pool);
    assert.equal(resourcesAt(childHome)[0].holders.length, 1, 'the foreign marker did not suppress local acquisition');
  } finally {
    childLease?.release();
    parentLease.release();
  }
});

/** Prove a released token cannot be reused even when its pool marker still matches. */
test('resources.inheritance.a-released-same-pool-token-is: a released same-pool token is refused instead of being inherited [Q1,Q2,Q3]', async () => {
  const home = machinePool();
  const lease = await acquireGate(home);
  const markers = gateSlotEnvironment(lease);
  lease.release();
  assert.throws(
    () => withEnvironment({ PULLBOARD_MACHINE_HOME: home, ...markers }, () => inheritedGateSlot({ root: process.cwd() })),
    (error) => error.code === 'GATE_SLOT_LEASE_LOST',
  );
});

/** Prove a Chrome child cannot queue while carrying only the parent's ordinary gate slot. */
test('resources.inheritance.a-browser-child-refuses-a-live: a browser child refuses a live gate-only lease without joining the queue [Q1,Q2,Q3]', async () => {
  const home = machinePool();
  const lease = await acquireGate(home);
  try {
    const markers = gateSlotEnvironment(lease);
    assert.throws(
      () => withEnvironment({ PULLBOARD_MACHINE_HOME: home, ...markers }, () => inheritedGateSlot({ root: process.cwd(), browser: true })),
      (error) => error.code === 'BROWSER_SLOT_REQUIRED',
    );
    const gate = resourcesAt(home).find((resource) => resource.name === 'gate');
    assert.equal(gate.line.length, 0, 'refusing the missing browser capacity creates no waiter');
    assert.equal(gate.holders.length, 1, 'the parent keeps its original gate lease');
  } finally { lease.release(); }
});

/** Prove the browser marker must match the live holder row, including its positive held value. */
test('resources.inheritance.a-forged-browser-marker-is-refused: a forged browser marker is refused against the live composite lease [Q1,Q2,Q3]', async () => {
  const home = machinePool();
  const lease = await acquireGate(home, true);
  try {
    const markers = gateSlotEnvironment(lease);
    assert.equal(markers[BROWSER_SLOT_HELD_ENV], '1');
    const valid = withEnvironment({ PULLBOARD_MACHINE_HOME: home, ...markers }, () => inheritedGateSlot({ root: process.cwd(), browser: true }));
    assert.equal(valid.browser, true);
    const forged = { ...markers, [BROWSER_SLOT_HELD_ENV]: '' };
    assert.throws(
      () => withEnvironment({ PULLBOARD_MACHINE_HOME: home, ...forged }, () => inheritedGateSlot({ root: process.cwd(), browser: true })),
      (error) => error.code === 'GATE_SLOT_MARKER_INVALID',
    );
  } finally { lease.release(); }
});
