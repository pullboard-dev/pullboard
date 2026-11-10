/** Private real resource queues retain runner browser capacity and isolate fixture work [Q1,Q2,C7]. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import {
  takeResource,
  listResources,
  gateSlotEnvironment,
} from '../../../../../packages/resources/index.js';
import { gateRunnerAdmission } from '../../../../../packages/config/index.js';
import { withGateSlot } from '../../../../../packages/gate/index.js';
import {
  apiFixtureEnvironment,
  bindApiFixtureMachine,
} from '../../../tests/fixtures/api.js';
import {
  startFixtureChild,
  runFixtureGit,
} from '../../../tests/fixtures/child.js';
import {
  executionServices,
  executionServicesSource,
} from '../../../tests/fixtures/gate/execution.js';

/** Own a private outer machine and restore the test runner's actual sandbox after the contract. */
function machine(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-browser-runners-'));
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(directory, 'outer');
  mkdirSync(process.env.PULLBOARD_MACHINE_HOME);
  t.after(() => {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, home: process.env.PULLBOARD_MACHINE_HOME };
}

test('runner-only browser work admits two slots on each runner despite one local browser slot [Q1,Q2]', { timeout: 60_000 }, async t => {
  const box = machine(t);
  const runners = [{ host: 'fixture-a', slots: 2, browser: 2 }, { host: 'fixture-b', slots: 2, browser: 2 }];
  writeFileSync(join(box.home, 'settings.json'), JSON.stringify({ gateSlots: 1, browserSlots: 1, gate: { runnersOnly: true }, runners }));
  const admission = gateRunnerAdmission();
  assert.equal(admission.runnerOnly, true);
  const options = { name: 'gate', scope: 'machine', root: box.directory, repo: box.directory, capacity: 1,
    browserCapacityProvider: () => 1, browser: true, ...admission, runnerProvider: () => runners };
  const leases = [];
  let fifth;
  try {
    for (let i = 0; i < 4; i += 1) leases.push(await takeResource({ ...options, agent: `fixture-browser-${i}`,
      onWait() { throw new Error('a registered browser slot is free; local capacity must not queue this work'); } }));
    assert.deepEqual(leases.map(lease => lease.runner.host).sort(), ['fixture-a', 'fixture-a', 'fixture-b', 'fixture-b']);
    assert.equal(listResources({ scope: 'machine' }).find(row => row.name === 'browser').capacity, 1, 'local capacity remains local');
    let queued;
    const waiting = new Promise(resolve => { queued = resolve; });
    const pending = takeResource({ ...options, agent: 'fixture-fifth-browser', onWait: state => queued(state) });
    assert.ok((await waiting).position > 0, 'a fifth browser waits for an actual runner slot');
    leases.shift().release();
    fifth = await pending;
    assert.ok(fifth.runner, 'the released remote slot admits the fifth browser without local fallback');
    for (const row of listResources({ scope: 'machine' }).filter(row => row.name.startsWith('runner:'))) {
      assert.ok(row.holders.length <= 2, 'no runner exceeds its real registered capacity');
    }
  } finally { fifth?.release(); for (const lease of leases) lease.release(); }
});

test('the actual HTTP fixture environment never joins or borrows the outer browser queue [Q1,Q2,C7]', { timeout: 60_000 }, async t => {
  const box = machine(t);
  const holder = await takeResource({ name: 'gate', scope: 'machine', root: box.directory, repo: box.directory,
    capacity: 1, browserCapacityProvider: () => 1, browser: true, agent: 'outer-browser-holder' });
  const fixtureRoot = join(box.directory, 'fixture-board', '.claude', 'worktrees', 'app-1');
  mkdirSync(fixtureRoot, { recursive: true });
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: fixtureRoot });
  const script = join(box.directory, 'fixture-run.mjs');
  const gate = new URL('../../../../../packages/gate/index.js', import.meta.url).href;
  writeFileSync(script, `import { withGateSlot } from ${JSON.stringify(gate)};
${executionServicesSource(gate)}
const release = new Promise(done => process.stdin.once('end', done));
process.stdin.resume();
try {
  await withGateSlot(process.cwd(), async lease => {
    console.log(JSON.stringify({ state: 'admitted', pool: lease.pool, inherited: lease.inherited === true }));
    await release;
  }, { executionServices, browser: true, remote: false, agent: 'fixture-app-1',
    readMemory: async () => ({ checked: true, availableBytes: 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3, pressure: 'normal' }),
    onWait: async state => {
      if (state.admitted) return;
      console.log(JSON.stringify({ state: 'queued' })); await release; throw new Error('fixture cancellation');
    } });
} catch (error) { if (error.message !== 'fixture cancellation') throw error; }
`);
  const env = { ...apiFixtureEnvironment(box.directory, box.directory), ...gateSlotEnvironment(holder) };
  // An authentic outer lease cannot be inherited across the independently selected fixture pool.
  const child = startFixtureChild(process.execPath, [script], { cwd: fixtureRoot, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  const lines = createInterface({ input: child.stdout });
  try {
    const [line] = await once(lines, 'line');
    const observed = JSON.parse(line);
    assert.equal(observed.state, 'admitted', 'the fixture must not wait behind the outer machine holder');
    assert.equal(env.PULLBOARD_MACHINE_HOME, join(box.directory, 'machine-home'), 'the incident fixture owns its machine pool even outside run-tests');
    assert.notEqual(observed.pool, holder.pool, 'the actual public gate uses a distinct fixture pool');
    assert.equal(observed.inherited, false, 'a different pool cannot borrow the outer lease');
    const outer = listResources({ scope: 'machine' });
    assert.ok(outer.every(row => [...row.holders, ...row.line].every(entry => entry.agent !== 'fixture-app-1')));
    assert.equal(outer.find(row => row.name === 'gate').holders[0].agent, 'outer-browser-holder');
  } finally {
    child.stdin.end();
    const [code] = await closed;
    lines.close();
    holder.release();
    assert.equal(code, 0, child.fixtureFailure ?? 'fixture cleanup completes normally');
  }
});

test('in-process HTTP fixture admission stays private and restores the ambient pool after multiple boards [Q1,Q2,C7]', { timeout: 60_000 }, async t => {
  const box = machine(t);
  const holder = await takeResource({ name: 'gate', scope: 'machine', root: box.directory, repo: box.directory,
    capacity: 1, browserCapacityProvider: () => 1, browser: true, agent: 'outer-in-process-holder' });
  const markers = gateSlotEnvironment(holder);
  const previous = Object.fromEntries(Object.keys(markers).map(key => [key, process.env[key]]));
  Object.assign(process.env, markers);
  try {
    await t.test('the fixture binds both of its board environments', async inner => {
      bindApiFixtureMachine(inner, apiFixtureEnvironment(join(box.directory, 'first'), box.directory));
      assert.equal(process.env.PULLBOARD_MACHINE_HOME, join(box.directory, 'first', 'machine-home'));
      const env = apiFixtureEnvironment(join(box.directory, 'second'), box.directory);
      bindApiFixtureMachine(inner, env);
      const root = join(box.directory, 'in-process-board');
      mkdirSync(root);
      runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root });
      await withGateSlot(root, async lease => {
        assert.equal(process.env.PULLBOARD_MACHINE_HOME, env.PULLBOARD_MACHINE_HOME);
        assert.notEqual(lease.pool, holder.pool, 'the actual in-process gate uses the fixture pool');
        assert.equal(lease.inherited === true, false, 'an outer lease is not borrowed by the fixture');
        const privateHome = process.env.PULLBOARD_MACHINE_HOME;
        try {
          process.env.PULLBOARD_MACHINE_HOME = box.home;
          const outer = listResources({ scope: 'machine' });
          assert.ok(outer.every(row => [...row.holders, ...row.line].every(entry => entry.agent !== 'fixture-in-process')));
          assert.equal(outer.find(row => row.name === 'gate').holders[0].agent, 'outer-in-process-holder');
        } finally { process.env.PULLBOARD_MACHINE_HOME = privateHome; }
      }, { executionServices,
        browser: true, remote: false, agent: 'fixture-in-process',
        readMemory: async () => ({ checked: true, availableBytes: 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3, pressure: 'normal' }),
        onWait: state => { if (!state.admitted) throw new Error('a private fixture must not queue behind the outer holder'); } });
    });
    assert.equal(process.env.PULLBOARD_MACHINE_HOME, box.home, 'one teardown restores the original ambient home after multiple bindings');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    holder.release();
  }
});
