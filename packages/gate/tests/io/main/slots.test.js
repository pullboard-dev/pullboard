/** Gate processes share the machine slot queue: FIFO order, shared pools across PULLBOARD_HOME, exact-tree cache starts, and slot release on SIGKILL [Q4,O5,O6]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { fixture } from '../../fixtures/resource.js';
import { gateRepo } from '../../fixtures/resource.js';
import { waitFor } from '../../fixtures/resource.js';
import { events } from '../../fixtures/resource.js';
import { reapFixtures } from '../../fixtures/resource.js';
import { launch } from '../../fixtures/resource.js';
import { runGateSync } from '../../fixtures/resource.js';
import { setGateSlots } from '../../fixtures/resource.js';

after(reapFixtures);

test('gate.io-main-resource.q4-o5-o6-gate-processes-run: [Q4,O5,O6] gate processes run one at a time in FIFO order when machine slots are one', async () => {
  const box = fixture();
  const releaseFirst = join(box.dir, 'release-first');
  const roots = ['first', 'second', 'third'].map((name) => gateRepo(box, name, name === 'first' ? 0.1 : 0.2, name === 'first' ? releaseFirst : null));
  assert.equal(setGateSlots(box, roots[0], 1).gateSlots, 1);
  const first = launch(box, roots[0]);
  await waitFor(() => events(box).includes('first start') && !events(box).includes('first end'), 'first gate to remain active', 30_000); // budget: hang ceiling for the private first-gate marker handshake; no throughput claim.
  const second = launch(box, roots[1]);
  await waitFor(() => second.stdoutText.includes('place 1'), 'second gate to enter the FIFO line');
  assert.match(second.stdoutText, /1 running/);
  assert.ok(second.stdoutText.includes(roots[0]), 'wait report names the repo holding the slot');
  const third = launch(box, roots[2]);
  await waitFor(() => third.stdoutText.includes('place 2'), 'third gate to enter behind the second');
  assert.ok(events(box).includes('first start') && !events(box).includes('first end'), 'both successors queued while the first gate still held its slot');
  writeFileSync(releaseFirst, 'release\n');
  const results = await Promise.all([first.closed, second.closed, third.closed]);
  assert.deepEqual(results.map(({ code }) => code), [0, 0, 0], `${first.stderrText}${second.stderrText}${third.stderrText}`);
  const starts = events(box).filter((line) => line.endsWith(' start')).map((line) => line.split(' ')[0]);
  assert.deepEqual(starts, ['first', 'second', 'third']);
  let running = 0;
  let maximum = 0;
  for (const line of events(box)) {
    if (line.endsWith(' start')) running += 1;
    else running -= 1;
    maximum = Math.max(maximum, running);
  }
  assert.equal(maximum, 1);
});

test('gate.io-main-resource.q4-gates-with-different-pullboard-home: [Q4] gates with different PULLBOARD_HOME values share the machine pool unless explicitly separated', async () => {
  const shared = fixture();
  const releaseShared = join(shared.dir, 'release-shared');
  const firstRoot = gateRepo(shared, 'shared-first', 0, releaseShared);
  const otherBoardHome = { ...shared, env: { ...shared.env, PULLBOARD_HOME: join(shared.dir, 'other-board-home') } };
  const secondRoot = gateRepo(otherBoardHome, 'shared-second', 0, releaseShared);
  setGateSlots(shared, firstRoot, 1);
  const first = launch(shared, firstRoot);
  let second;
  try {
    await waitFor(() => events(shared).includes('shared-first start'), 'first shared-pool gate to start');
    second = launch(otherBoardHome, secondRoot);
    await waitFor(
      () => second.stdoutText.includes('place 1') || events(shared).includes('shared-second start'),
      'gate with another board home to queue or start on the shared machine pool',
    );
    assert.ok(second.stdoutText.includes('place 1'), 'the other board home is queued behind the first gate');
    assert.deepEqual(events(shared), ['shared-first start']);
    writeFileSync(releaseShared, 'release');
    const results = await Promise.all([first.closed, second.closed]);
    assert.deepEqual(results.map(({ code }) => code), [0, 0], `${first.stderrText}${second.stderrText}`);
    assert.deepEqual(events(shared), ['shared-first start', 'shared-first end', 'shared-second start', 'shared-second end']);
  } finally {
    writeFileSync(releaseShared, 'release');
    await Promise.all([first, second].filter(Boolean).map((child) => child.closed));
  }

  const separated = fixture();
  const releaseSeparated = join(separated.dir, 'release-separated');
  const firstPool = { ...separated, env: { ...separated.env, PULLBOARD_MACHINE_HOME: join(separated.dir, 'machine-first') } };
  const secondPool = {
    ...separated,
    env: {
      ...separated.env,
      PULLBOARD_MACHINE_HOME: join(separated.dir, 'machine-second'),
    },
  };
  const isolatedFirstRoot = gateRepo(firstPool, 'isolated-first', 0, releaseSeparated);
  const isolatedSecondRoot = gateRepo(secondPool, 'isolated-second', 0, releaseSeparated);
  for (const [box, root] of [[firstPool, isolatedFirstRoot], [secondPool, isolatedSecondRoot]]) {
    setGateSlots(box, root, 1);
  }
  const isolatedFirst = launch(firstPool, isolatedFirstRoot);
  let isolatedSecond;
  try {
    await waitFor(() => events(separated).includes('isolated-first start'), 'first isolated-pool gate to start');
    isolatedSecond = launch(secondPool, isolatedSecondRoot);
    await waitFor(() => events(separated).includes('isolated-second start'), 'explicit private pool to acquire while the first pool is occupied');
    assert.deepEqual(events(separated), ['isolated-first start', 'isolated-second start']);
    writeFileSync(releaseSeparated, 'release');
    const results = await Promise.all([isolatedFirst.closed, isolatedSecond.closed]);
    assert.deepEqual(results.map(({ code }) => code), [0, 0], `${isolatedFirst.stderrText}${isolatedSecond.stderrText}`);
    assert.deepEqual(events(separated).slice(0, 2), ['isolated-first start', 'isolated-second start']);
    assert.deepEqual(events(separated).slice(2).sort(), ['isolated-first end', 'isolated-second end']);
  } finally {
    writeFileSync(releaseSeparated, 'release');
    await Promise.all([isolatedFirst, isolatedSecond].filter(Boolean).map((child) => child.closed));
  }
});

test('gate.io-main-resource.q4-an-exact-tree-cached-gate: [Q4] an exact-tree cached gate starts while another machine gate holds the only slot', async () => {
  const box = fixture();
  const cachedRoot = gateRepo(box, 'cached', 0.1);
  const releaseHolder = join(box.dir, 'release-holder');
  const holderRoot = gateRepo(box, 'holder', 0.1, releaseHolder);
  setGateSlots(box, holderRoot, 1);
  const warm = runGateSync(box, cachedRoot);
  assert.equal(warm.status, 0, warm.stderr);
  const priorCount = events(box).filter((line) => line.startsWith('cached ')).length;
  const holder = launch(box, holderRoot);
  await waitFor(() => events(box).includes('holder start') && !events(box).includes('holder end'), 'uncached holder gate to remain active', 30_000); // budget: hang ceiling for the private holder-gate marker handshake; no throughput claim.
  // A busy equal-capacity write is a no-op; raising capacity is now allowed by #778.
  setGateSlots(box, cachedRoot, 1);
  assert.equal(JSON.parse(readFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json'), 'utf8')).gateSlots, 1);
  const cached = runGateSync(box, cachedRoot);
  assert.equal(cached.status, 0, cached.stderr);
  assert.match(cached.stdout, /already passed/);
  assert.ok(events(box).includes('holder start') && !events(box).includes('holder end'), 'cached gate returned while the other machine gate still held its slot');
  assert.equal(events(box).filter((line) => line.startsWith('cached ')).length, priorCount, 'cached gate command did not run again');
  writeFileSync(releaseHolder, 'release\n');
  assert.equal((await holder.closed).code, 0, holder.stderrText);
  assert.ok(events(box).includes('holder end'), 'the holder exits only after the test releases it');
});

test('gate.io-main-resource.q4-sigkill-during-a-gate-releases: [Q4] SIGKILL during a gate releases its machine slot for the next process', async () => {
  const box = fixture();
  const deadRoot = gateRepo(box, 'dead', 20);
  const nextRoot = gateRepo(box, 'next', 0.1);
  setGateSlots(box, deadRoot, 1);
  const dead = launch(box, deadRoot);
  await waitFor(() => events(box).includes('dead start'), 'gate to hold a slot before it is killed');
  const next = launch(box, nextRoot);
  await waitFor(() => next.stdoutText.includes('place 1'), 'successor gate to queue');
  process.kill(-dead.pid, 'SIGKILL');
  assert.equal((await dead.closed).signal, 'SIGKILL');
  const result = await Promise.race([
    next.closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('successor did not acquire the freed slot')), 5_000)), // budget: hang ceiling for a freed slot acquisition; no throughput claim.
  ]);
  assert.equal(result.code, 0, next.stderrText);
  assert.ok(events(box).includes('next start'));
});


