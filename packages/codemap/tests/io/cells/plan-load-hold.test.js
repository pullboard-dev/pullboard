/** @pullboard-test-input source-cell codemap */
/** cells-plan --check and --moved wait in the local resource line above the load ceiling when machine.holdHeavyAboveLoad is on [C7,#10078]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../gate/tests/fixtures/testkit.js';
import { mkdirSync } from 'node:fs';

const BIN = fileURLToPath(new URL('../../../src/io/cells/scripts/plan.js', import.meta.url));
const WAIT = 'waits in the local resource line';

/** A private machine home whose settings hold the given machine values; removed when the test ends. */
function machineHome(t, machine) {
  const { root } = privateFixtureFiles('pullboard-plan-hold-');
  const home = join(root, 'machine-home');
  mkdirSync(home, { recursive: true });
  fixtureMachineSettings(home, { machine });
  return home;
}

/**
 * Run the real plan script in a worker thread (no process starts) with an isolated machine home, and resolve with what it said
 * once it waits, prints, or exits; the worker is stopped at that point.
 */
function runPlan(home, args, until) {
  return new Promise((done, fail) => {
    const env = { ...process.env, PULLBOARD_MACHINE_HOME: home };
    for (const key of ['NODE_TEST_CONTEXT', 'PULLBOARD_TEST_FILE_POOL', 'PULLBOARD_GATE_SLOT_HELD']) delete env[key];
    const worker = new Worker(BIN, { argv: args, stdout: true, stderr: true, env, execArgv: [] });
    const seen = { stdout: '', stderr: '', exited: false };
    let stopping = false;
    const settle = () => { stopping = true; worker.terminate().finally(() => done(seen)); };
    worker.stdout.on('data', chunk => { seen.stdout += chunk; if (until(seen)) settle(); });
    worker.stderr.on('data', chunk => { seen.stderr += chunk; if (until(seen)) settle(); });
    worker.on('error', error => { seen.stderr += error.stack ?? String(error); });
    worker.on('exit', () => { if (!stopping) { seen.exited = true; done(seen); } });
    worker.on('messageerror', fail);
  });
}

test('codemap.plan-load-hold.check-waits: clause 1: cells-plan --check waits in the local resource line before any plan output when the hold is on and the load ceiling is tiny [C7,#10078]', async t => {
  const home = machineHome(t, { holdHeavyAboveLoad: true, loadCeiling: 0.0001 });
  const seen = await runPlan(home, ['--check'], found => found.stderr.includes(WAIT));
  assert.match(seen.stderr, /cells-plan --check waits in the local resource line/u);
  assert.equal(seen.exited, false, 'the command is still waiting, not finished');
  assert.equal(seen.stdout, '', 'no plan output before the wait ends');
});

test('codemap.plan-load-hold.moved-waits: clause 2: cells-plan --moved waits in the local resource line before any plan output when the hold is on and the load ceiling is tiny [C7,#10078]', async t => {
  const home = machineHome(t, { holdHeavyAboveLoad: true, loadCeiling: 0.0001 });
  const seen = await runPlan(home, ['--moved', 'nosuchcell'], found => found.stderr.includes(WAIT));
  assert.match(seen.stderr, /cells-plan --moved waits in the local resource line/u);
  assert.equal(seen.exited, false, 'the command is still waiting, not finished');
  assert.equal(seen.stdout, '', 'no plan output before the wait ends');
});

test('codemap.plan-load-hold.off-runs: clause 3: with the hold off the same command under the same tiny ceiling prints no wait line and runs [C7,#10078]', async t => {
  const home = machineHome(t, { holdHeavyAboveLoad: false, loadCeiling: 0.0001 });
  const seen = await runPlan(home, ['--moved', 'nosuchcell'], found => found.stderr.length + found.stdout.length > 0);
  assert.ok(seen.stderr.length + seen.stdout.length > 0 || seen.exited, 'the command ran and said something or finished');
  assert.doesNotMatch(seen.stderr, /waits in the local resource line/u);
});

test('codemap.plan-load-hold.verification-order: clause 1: live owned imports and prerequisites produce a deterministic order without rewriting history [C7,D3]', async () => {
  const { verificationOrder } = await import('../../../src/io/cells/plan.js');
  const plan = { cells: [
    { name: 'alpha', order: 1, paths: [], cuts: [{ cell: 'beta', imports: 1 }], item: { after: ['gamma'], criterion: 'issued bar' } },
    { name: 'beta', order: 2, paths: [], cuts: [], item: { after: [] } },
    { name: 'gamma', order: 3, paths: [], cuts: [], item: { after: [] } },
  ] };
  const before = JSON.stringify(plan);
  const edges = new Map([
    ['packages/alpha/src/a.js', [{ target: 'packages/beta/index.js' }]],
    ['packages/beta/src/b.js', [{ target: 'packages/gamma/index.js' }, { target: 'packages/alpha/index.js' }]],
  ]);
  assert.deepEqual(verificationOrder(plan, edges), ['gamma', 'beta', 'alpha']);
  assert.deepEqual(verificationOrder(plan, new Map([...edges].reverse())), ['gamma', 'beta', 'alpha']);
  assert.equal(JSON.stringify(plan), before, 'history and declared cuts remain untouched');
  const { readPlan, cellInventory } = await import('../../../index.js');
  const { importsIn, commonJsIn } = await import('../../../../gate/heavy.js');
  const root = fileURLToPath(new URL('../../../../..', import.meta.url));
  const live = readPlan(root), liveBefore = JSON.stringify(live);
  const { edges: currentEdges } = cellInventory(root, { importsIn, commonJsIn });
  const order = verificationOrder(live, currentEdges);
  assert.equal(order.length, live.cells.length);
  assert.equal(new Set(order).size, live.cells.length);
  assert.ok(order.indexOf('health') < order.indexOf('api'), 'the real api to health import is ordered leaf-first');
  assert.equal(JSON.stringify(live), liveBefore, 'the current plan is not changed');
});

test('codemap.plan-load-hold.verification-cycle: clause 2: an uncut live cycle is refused with its participating cells [C7,D3]', async () => {
  const { verificationOrder } = await import('../../../src/io/cells/plan.js');
  const plan = { cells: ['alpha', 'beta', 'gamma'].map(name => ({ name, paths: [], cuts: [], item: { after: [] } })) };
  const edges = new Map([
    ['packages/alpha/src/a.js', [{ target: 'packages/beta/index.js' }]],
    ['packages/beta/src/b.js', [{ target: 'packages/alpha/index.js' }]],
    ['packages/gamma/src/c.js', [{ target: 'packages/alpha/index.js' }]],
  ]);
  assert.throws(() => verificationOrder(plan, edges), error => error.code === 'CELLS_PLAN_ORDER_CYCLE' && /alpha -> beta -> alpha/u.test(error.message) && !error.message.includes('gamma'));
});
