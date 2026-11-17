/** A machine over its load ceiling holds heavy local work in the local resource line, on an injected load reading [Q1,C7,#2466]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { listResources } from '../../index.js';
import { loadCeilingOf } from '../../index.js';
import { setMachineLoadPort } from '../../index.js';
import { withHeavyLocalWork } from '../../index.js';

/** Inject the host readings on an isolated machine home, outside any admitted gate run; restore all after the test. */
function injectLoad(t, reading) {
  const restore = setMachineLoadPort({ loadavg: () => [reading.load, reading.load, reading.load], cores: () => 4 });
  const { root: home } = privateFixtureFiles('pullboard-load-ceiling-');
  const saved = { held: process.env.PULLBOARD_GATE_SLOT_HELD, home: process.env.PULLBOARD_MACHINE_HOME };
  delete process.env.PULLBOARD_GATE_SLOT_HELD;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => {
    restore();
    for (const [key, value] of [['PULLBOARD_GATE_SLOT_HELD', saved.held], ['PULLBOARD_MACHINE_HOME', saved.home]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });
  return reading;
}

/** Start heavy work and resolve once it says it waits, or once it finishes without waiting. */
function heavy(kind, settings, memory) {
  const said = [];
  let ran = false;
  let announced;
  const waiting = new Promise(resolve => { announced = resolve; });
  const done = withHeavyLocalWork(kind, () => { ran = true; return 'done'; },
    { settings: () => settings, memory, say: line => { said.push(line); announced(); } });
  done.finally(() => announced());
  return { said, waiting, done, ran: () => ran };
}

test('clause 1: machine.loadCeiling defaults to 1.5 times the logical cores and a set value replaces it [Q1,C7]', t => {
  injectLoad(t, { load: 1 });
  assert.equal(loadCeilingOf({}), 6);
  assert.equal(loadCeilingOf({ machine: { loadCeiling: null } }), 6);
  assert.equal(loadCeilingOf({ machine: { loadCeiling: 40 } }), 40);
});

for (const kind of ['cells-plan --moved', 'cells-plan --check', 'pullboard check', 'run-tests local fallback']) {
  test(`clause 2: ${kind} waits in the local resource line above the load ceiling, says why and for how long, and proceeds once the load drops [Q1,C7]`, async t => {
    const reading = injectLoad(t, { load: 30 });
    const work = heavy(kind, {});
    await work.waiting;
    assert.equal(work.ran(), false, 'the heavy command waits while the load is over the ceiling');
    assert.match(work.said[0], new RegExp(`^${kind} waits in the local resource line: load: holding heavy local work: 1-minute load 30 on 4 cores \\(ceiling 6\\); waited \\d+s$`, 'u'));
    const line = listResources({ scope: 'machine' }).find(resource => resource.name === 'heavy');
    assert.equal(line.line[0].memoryHeld, true, 'pullboard resources shows the waiter held by the machine');
    reading.load = 2;
    assert.equal(await work.done, 'done');
    assert.equal(work.ran(), true);
  });
}

test('clause 2: heavy local work also waits under gate.memoryFloorMB while the load is under its ceiling [Q1,C7]', async t => {
  injectLoad(t, { load: 1 });
  const memory = { held: true };
  const work = heavy('pullboard check', { gate: { memoryFloorMB: 1024 } },
    async () => ({ checked: true, held: memory.held, line: memory.held ? 'memory: holding local gate runs because free memory is under the floor' : 'memory: admitting' }));
  await work.waiting;
  assert.equal(work.ran(), false);
  assert.match(work.said[0], /^pullboard check waits in the local resource line: load: admitting: .*; memory: holding local gate runs because free memory is under the floor; waited \d+s$/u);
  memory.held = false;
  assert.equal(await work.done, 'done');
});

test('clause 3: below the load ceiling and the memory floor the same commands proceed at once, silently [Q1,C7]', async t => {
  injectLoad(t, { load: 2 });
  for (const kind of ['cells-plan --moved', 'cells-plan --check', 'pullboard check', 'run-tests local fallback']) {
    const work = heavy(kind, {});
    assert.equal(await work.done, 'done');
    assert.deepEqual(work.said, []);
  }
});

test('clause 3: work inside an admitted gate run is never held by the load that gate adds [Q1,C7]', async t => {
  injectLoad(t, { load: 30 });
  process.env.PULLBOARD_GATE_SLOT_HELD = '1';
  const work = heavy('run-tests local fallback', {});
  assert.equal(await work.done, 'done');
  assert.deepEqual(work.said, []);
});
