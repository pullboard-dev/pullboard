/** Original public capacity regressions, kept outside the over-cap resource test module [Q1,Q2,Q4]. */
import assert from 'node:assert/strict';

/** Change gate capacity through the config cell in this fixture's private machine home. */
function configureGateSlots(tools, box, slots) {
  return tools.machineSettings(box, 'setGateSlots', slots);
}

/** Change browser capacity through the config cell in this fixture's private machine home. */
function configureBrowserSlots(tools, box, slots) {
  return tools.machineSettings(box, 'setBrowserSlots', slots);
}

/**
 * Bind the existing resource fixture tools to the original regression callbacks.
 * @param {any} tools - The unchanged resource-test helpers and worker source, plus machineSettings from the caller.
 * @returns {{raising: Function, lowering: Function, browser: Function}}
 */
export function capacityChangeCases(tools) {
  return { raising: raising.bind(null, tools), lowering: lowering.bind(null, tools), browser: browser.bind(null, tools) };
}

/** Exercise the original raising capacity case through the config cell. */
async function raising(tools) {
  const { fixture, worker, event, acquired, release, privateList, poolWorker, POOL_MODULE_WORKER } = tools;
  const box = fixture();
  const children = [];
  try {
    for (const agent of ['raise-holder-one', 'raise-holder-two']) {
      const child = worker(box, { capacity: 2, agent }); children.push(child);
      assert.equal((await acquired(child)).acquired, agent);
    }
    for (const agent of ['raise-waiter-one', 'raise-waiter-two']) {
      const child = worker(box, { capacity: 2, agent }); children.push(child);
      assert.ok((await event(child)).waiting, 'the existing taker is queued before the setting changes');
    }
    const raised = configureGateSlots(tools, box, 4);
    assert.equal(raised.error, undefined, raised.error?.message);
    assert.equal(raised.value.gateSlots, 4);
    for (const child of children.slice(2)) await acquired(child);
    const gate = privateList(box).find(row => row.name === 'gate');
    assert.equal(gate.capacity, 4, 'resources reports the raised machine capacity');
    assert.deepEqual(gate.holders.map(row => row.agent).sort(),
      ['raise-holder-one', 'raise-holder-two', 'raise-waiter-one', 'raise-waiter-two'].sort());
    assert.ok(children.every(child => child.exitResult === null), 'the original holders and newly admitted waiters remain running');
    const next = worker(box, { capacity: 4, agent: 'after-raise-waiter' }); children.push(next);
    assert.ok((await event(next)).waiting, 'the raised capacity is still a real limit');
    await release(children[0]);
    assert.equal((await acquired(next)).acquired, 'after-raise-waiter');
  } finally { for (const child of children) if (!child.exitResult) await release(child); }
}

/** Exercise the original lowering capacity case through the config cell. */
async function lowering(tools) {
  const { fixture, worker, event, acquired, release, privateList, poolWorker, POOL_MODULE_WORKER } = tools;
  const box = fixture();
  assert.equal(configureGateSlots(tools, box, 4).error, undefined);
  const children = [];
  try {
    for (const agent of ['lower-one', 'lower-two', 'lower-three', 'lower-four']) {
      const child = worker(box, { capacity: 4, agent }); children.push(child);
      await acquired(child);
    }
    const before = privateList(box).find(row => row.name === 'gate');
    const lowered = configureGateSlots(tools, box, 1);
    assert.ok(lowered.error, 'a decrease below live holders is refused rather than evicting them');
    const error = lowered.error;
    assert.equal(error.code, 'RESOURCE_BUSY');
    for (const child of children) assert.ok(error.message.includes(child.spawnargs.at(-3)),
      'the refusal identifies each live holder');
    const after = privateList(box).find(row => row.name === 'gate');
    assert.deepEqual(after, before, 'a refused decrease leaves the resource and leases unchanged');
    assert.ok(children.every(child => child.exitResult === null), 'no running holder was stopped');
    const settings = tools.machineSettings(box, 'loadMachineSettings');
    assert.equal(settings.value.gateSlots, 4, 'the refused decrease did not change settings');
    for (const child of children) await release(child);
    const changed = configureGateSlots(tools, box, 1);
    assert.equal(changed.error, undefined, changed.error?.message);
    assert.equal(privateList(box).find(row => row.name === 'gate').capacity, 1,
      'the same decrease works after the holders finish');
  } finally { for (const child of children) if (!child.exitResult) await release(child); }
}

/** Exercise the original browser capacity case through the config cell. */
async function browser(tools) {
  const { fixture, worker, event, acquired, release, privateList, poolWorker, POOL_MODULE_WORKER } = tools;
  const box = fixture();
  assert.equal(configureGateSlots(tools, box, 4).error, undefined);
  const script = POOL_MODULE_WORKER.replace('capacity: 2,',
    'capacity: loadMachineSettings().gateSlots, capacityProvider: () => loadMachineSettings().gateSlots,');
  const children = [];
  try {
    const first = poolWorker(box, { agent: 'browser-holder', browser: true, script }); children.push(first);
    await acquired(first);
    for (const agent of ['browser-waiter-one', 'browser-waiter-two', 'browser-waiter-three']) {
      const child = poolWorker(box, { agent, browser: true, script }); children.push(child);
      assert.ok((await event(child)).queued, 'the browser taker waits before browserSlots is raised');
    }
    const raised = configureBrowserSlots(tools, box, 3);
    assert.equal(raised.error, undefined, raised.error?.message);
    for (const child of children.slice(1, 3)) await acquired(child);
    const rows = privateList(box);
    assert.equal(rows.find(row => row.name === 'browser').capacity, 3);
    assert.equal(rows.find(row => row.name === 'browser').holders.length, 3);
    assert.equal(rows.find(row => row.name === 'gate').holders.length, 3);
    assert.equal(rows.find(row => row.name === 'browser').line.length, 1,
      'the fourth browser stays queued even though a gate slot is free');
    await release(first);
    await acquired(children[3]);
    assert.equal(privateList(box).find(row => row.name === 'browser').holders.length, 3);
  } finally { for (const child of children) if (!child.exitResult) await release(child); }
}
