/** Timing checks hold an entire physical machine, including its short slots [C7,Q1]. */
import { executionServicesSource } from '../../../../../apps/cli/tests/fixtures/gate/execution.js';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellProject } from '../../../../store/tests/fixtures/cell.js';
import { runFixtureChildAsync } from '../../../../../apps/cli/tests/fixtures/child.js';
import { BROWSER_SLOT_HELD_ENV } from '../../../../resources/index.js';
import { GATE_SLOT_HELD_ENV } from '../../../../resources/index.js';
import { GATE_SLOT_POOL_ENV } from '../../../../resources/index.js';
import { GATE_SLOT_TOKEN_ENV } from '../../../../resources/index.js';

/** A real board and Git checkout with a private two-slot machine and no inherited outer lease. */
function fixture(t) {
  const box = cellProject(t, { model: 'gate-test-fixture' });
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  writeFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json'), JSON.stringify({ gateSlots: 2, browserSlots: 1, gate: { shortSlots: 1 } }));
  for (const key of [GATE_SLOT_HELD_ENV, GATE_SLOT_POOL_ENV, GATE_SLOT_TOKEN_ENV, BROWSER_SLOT_HELD_ENV]) delete box.env[key];
  return box;
}

/** Run the public admission APIs in the private machine and preserve all failed output. */
async function runFixture(box, body) {
  const source = `import assert from 'node:assert/strict';
import { takeResource, listResources, gateSlotEnvironment } from ${JSON.stringify(new URL('../../../../resources/index.js', import.meta.url).href)};
import { withGateSlot } from ${JSON.stringify(new URL('../../../index.js', import.meta.url).href)};
${executionServicesSource(new URL('../../../index.js', import.meta.url).href)}
const root = process.cwd();
${body}`;
  const result = await runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', source], { cwd: box.repo, env: box.env });
  assert.equal(result.status, 0, `${result.context}\n${result.stdout}\n${result.stderr}`);
  return result;
}

test('timing admission drains ordinary work and excludes ordinary and short slots [C7,Q1]', async t => {
  const box = fixture(t);
  await runFixture(box, `
const leases = [];
const base = { name: 'gate', capacity: 2, scope: 'machine', root, browser: false };
try {
  const ordinary = await takeResource({ ...base, agent: 'ordinary-before' }); leases.push(ordinary);
  let waiting;
  const observed = new Promise(resolve => { waiting = resolve; });
  const pending = takeResource({ ...base, timing: true, agent: 'timing', onWait: state => waiting({ state }) });
  pending.then(lease => { leases.push(lease); waiting({ lease }); });
  const first = await observed;
  assert.ok(first.state, 'timing waits even when one of two ordinary slots is free');
  assert.equal(listResources({ root }).find(row => row.name === 'gate').holders.length, 1);
  ordinary.release();
  const timing = await pending;
  assert.equal(timing.timing, true, 'the real lease carries exclusive timing admission');
  const holder = listResources({ root }).find(row => row.name === 'gate').holders;
  assert.equal(holder.length, 1);
  assert.equal(holder[0].timing, true);
  let secondWaiting;
  const secondObserved = new Promise(resolve => { secondWaiting = resolve; });
  const next = takeResource({ ...base, agent: 'ordinary-after', shortEligible: true,
    shortCapacityProvider: () => 1, onWait: state => secondWaiting({ state }) });
  next.then(lease => { leases.push(lease); secondWaiting({ lease }); });
  const second = await secondObserved;
  assert.ok(second.state, 'an exclusive timing lease blocks ordinary and spare short capacity');
  timing.release();
  const after = await next;
  assert.equal(after.timing, false);
  after.release();
  assert.equal(listResources({ root }).find(row => row.name === 'gate').holders.length, 0);
} finally { for (const lease of leases.reverse()) lease.release(); }
`);
});

test('timing cannot escalate an inherited ordinary lease and its receipt records actual load [C7,Q1]', async t => {
  const box = fixture(t);
  await runFixture(box, `
const ordinary = await takeResource({ name: 'gate', capacity: 2, scope: 'machine', root });
try {
  Object.assign(process.env, gateSlotEnvironment(ordinary));
  await assert.rejects(withGateSlot(root, () => assert.fail('ordinary lease must not run a timing check'),
    { executionServices, timing: true, remote: false }), { code: 'TIMING_SLOT_REQUIRED' });
} finally {
  ordinary.release();
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete process.env[key];
}
let receipt;
await withGateSlot(root, async lease => {
  assert.equal(lease.timing, true);
  Object.assign(process.env, gateSlotEnvironment(lease));
  try { assert.equal(await withGateSlot(root, inherited => inherited.timing, { executionServices, timing: true, remote: false }), true); }
  finally { for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete process.env[key]; }
}, { executionServices, timing: true, remote: false, onReceipt: value => { receipt = value; } });
assert.equal(receipt.timing, true);
assert.equal(receipt.exclusive, true);
assert.deepEqual(receipt.unfencedClients, []);
assert.equal(receipt.runner.kind, 'local');
for (const sample of [receipt.load.start, receipt.load.end]) {
  assert.ok(Number.isFinite(Date.parse(sample.at)), 'load has an executor timestamp');
  assert.equal(sample.average.length, 3);
  assert.ok(sample.average.every(Number.isFinite));
  assert.ok(Number.isSafeInteger(sample.cpus) && sample.cpus > 0);
}
assert.ok(Date.parse(receipt.load.end.at) >= Date.parse(receipt.load.start.at));
assert.ok(Date.parse(receipt.finishedAt) >= Date.parse(receipt.admittedAt));
`);
});

test('a legacy queue client makes the timing receipt explicitly unfenced even after it exits [C7,Q1]', async t => {
  const box = fixture(t);
  await runFixture(box, `
const { takeResource: legacyTakeResource } = await import(${JSON.stringify(new URL('../../../../../apps/cli/tests/fixtures/runners.js', import.meta.url).href)});
let receipt;
await withGateSlot(root, async lease => {
  assert.equal(lease.timingEvidence().exclusive, true);
  const legacy = await legacyTakeResource({ name: 'gate', capacity: 2, scope: 'machine', root, agent: 'legacy-unfenced-fixture' });
  try { assert.equal(listResources({ root }).find(row => row.name === 'gate').holders.length, 2); }
  finally { legacy.release(); }
  assert.equal(listResources({ root }).find(row => row.name === 'gate').holders.length, 1,
    'the short legacy run already left before the receipt is captured');
}, { executionServices, timing: true, remote: false, onReceipt: value => { receipt = value; } });
assert.equal(receipt.exclusive, false, 'a number measured beside an unfenced client cannot claim isolation');
assert.ok(receipt.unfencedClients.some(client => client.agent === 'legacy-unfenced-fixture'));
`);
});
