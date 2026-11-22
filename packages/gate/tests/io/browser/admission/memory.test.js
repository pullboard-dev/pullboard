import assert from 'node:assert/strict';
import { runFixtureChild as spawnSync } from '../../../fixtures/child.js';
import { after } from 'node:test';
import { test } from 'node:test';
import { setResourceCapacity } from '../../../../../resources/index.js';
import { takeResource } from '../../../../../resources/index.js';
import { MODULE } from '../../../fixtures/admission/pool.js';
import { event } from '../../../fixtures/admission/pool.js';
import { fixture } from '../../../fixtures/admission/pool.js';
import { privateList } from '../../../fixtures/admission/pool.js';
import { release } from '../../../fixtures/admission/pool.js';
import { worker } from '../../../fixtures/admission/pool.js';
/** Real-process resource queue and lease coverage [Q1,Q2,Q3]. */
test('gate.io-browser-admission-memory.q4-machine-capacity-decreases-atomically-refuse: [Q4] machine capacity decreases atomically refuse an occupied or queued resource', async () => {
  const box = fixture();
  const oldHome = process.env.PULLBOARD_HOME;
  const oldMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_HOME = box.home;
  process.env.PULLBOARD_MACHINE_HOME = box.home;
  const holder = worker(box, { capacity: 2, agent: 'capacity-holder' });
  let secondHolder;
  let waiter;
  try {
    assert.equal((await event(holder)).acquired, 'capacity-holder');
    secondHolder = worker(box, { capacity: 2, agent: 'capacity-second-holder' });
    assert.equal((await event(secondHolder)).acquired, 'capacity-second-holder');
    waiter = worker(box, { capacity: 2, agent: 'capacity-waiter' });
    assert.equal((await event(waiter)).waiting, 1);
    let persisted = false;
    assert.throws(() => setResourceCapacity({ name: 'gate', capacity: 1, persist: () => { persisted = true; } }), (error) => error.code === 'RESOURCE_BUSY');
    assert.equal(persisted, false, 'settings remain unchanged while a holder and waiter exist');
    await release(holder);
    assert.equal((await event(waiter)).acquired, 'capacity-waiter');
    assert.throws(() => setResourceCapacity({ name: 'gate', capacity: 1, persist: () => { persisted = true; } }), (error) => error.code === 'RESOURCE_BUSY');
    await release(waiter);
    await release(secondHolder);
    const changed = setResourceCapacity({ name: 'gate', capacity: 3, persist: () => { persisted = true; } });
    assert.deepEqual(changed, { name: 'gate', capacity: 3 });
    assert.equal(persisted, true, 'settings persist under the same queue lock as the capacity');
    assert.equal(privateList(box)[0].capacity, 3);
    const lease = await takeResource({ name: 'gate', capacity: 3, capacityProvider: () => 4, allowIdleCapacityUpdate: true, root: box.first, agent: 'fresh-capacity' });
    assert.equal(privateList(box)[0].capacity, 4, 'a queued gate reads the latest setting after taking the SQLite lock');
    lease.release();
  } finally {
    if (!holder.exitResult) await release(holder);
    if (secondHolder && !secondHolder.exitResult) await release(secondHolder);
    if (waiter && !waiter.exitResult) await release(waiter);
    if (oldHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = oldHome;
    if (oldMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = oldMachineHome;
  }
});

test('gate.io-browser-admission-memory.q1-machine-scope-is-shared-repo: [Q1] machine scope is shared, repo scope stays local, and board scope names relay requirement', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'repo-a', root: box.first });
  assert.equal((await event(holder)).acquired, 'repo-a');
  const otherRepo = worker(box, { agent: 'repo-b', root: box.second });
  assert.equal((await event(otherRepo)).waiting, 1);
  await release(holder);
  assert.equal((await event(otherRepo)).acquired, 'repo-b');
  await release(otherRepo);
  const localA = worker(box, { name: 'repo-only', scope: 'repo', agent: 'repo-a', root: box.first });
  const localB = worker(box, { name: 'repo-only', scope: 'repo', agent: 'repo-b', root: box.second });
  assert.equal((await event(localA)).acquired, 'repo-a');
  assert.equal((await event(localB)).acquired, 'repo-b');
  await release(localA);
  await release(localB);
  const refused = spawnSync(process.execPath, ['--input-type=module', '-e', `import {takeResource} from ${JSON.stringify(MODULE)}; await takeResource({name:'x',capacity:1,scope:'board'});`], { env: box.env, encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /BOARD_SCOPE_UNAVAILABLE.*relay/i);
});

