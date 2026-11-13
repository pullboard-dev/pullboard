/** Gate commands, item checks and verify share the machine queue in order, and settings and resources print the short-slot state, through the real CLI [Q1,Q2,Q4,C7,V18]. */
import assert from 'node:assert/strict';
import { runFixtureChild as spawnSync } from '../../tests/fixtures/child.js';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { withNestedGroup } from '../../../../packages/gate/index.js';
import { fixture } from '../../tests/fixtures/gate/resource.js';
import { probeSuite } from '../../tests/fixtures/gate/resource.js';
import { launchTestRunner } from '../../tests/fixtures/gate/resource.js';
import { shortProbeSuite } from '../../tests/fixtures/gate/resource.js';
import { wholeSuiteInheritance } from '../../tests/fixtures/gate/resource.js';
import { launchOrdinaryLease } from '../../tests/fixtures/gate/resource.js';
import { wholeSuiteHolders } from '../../tests/fixtures/gate/resource.js';
import { releaseAll } from '../../tests/fixtures/gate/resource.js';
import { gateRepo } from '../../tests/fixtures/gate/resource.js';
import { waitFor } from '../../tests/fixtures/gate/resource.js';
import { PROBE_PATTERN } from '../../tests/fixtures/gate/resource.js';
import { reapFixtures } from '../../tests/fixtures/gate/resource.js';

const BIN = resolve(import.meta.dirname, '../../pullboard.js');

after(reapFixtures);

// process-level: this case runs beside whole-suite holders that must see real, separate callers.
/** Run one pullboard command as its own process in a fixture, require success, and return its output. */
function pullboardProcess(box, root, args) {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd: root, env: box.env, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.failure ?? ''}${result.stdout}${result.stderr}`);
  return result.stdout;
}

test('a short check never waits behind whole suites [C7]', async () => {
  const box = fixture();
  const settingsRoot = gateRepo(box, 'settings-view');
  assert.equal(JSON.parse(pullboardProcess(box, settingsRoot, ['settings', '--json'])).settings.gate.shortSlots, 0, 'gate.shortSlots defaults to 0');
  assert.match(pullboardProcess(box, settingsRoot, ['settings']), /^gate\.shortSlots: 0 \(off/mu, 'pullboard settings shows the default');
  // process-level: same reason as pullboardProcess above.
  const refused = spawnSync(process.execPath, [BIN, 'settings', 'gate.shortSlots', 'two'], { cwd: settingsRoot, env: box.env, encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  assert.match(`${refused.stdout}${refused.stderr}`, /BAD_SHORT_SLOTS/u);
  // Whole suites take a browser slot too; two of them fill a two-slot gate only with two browser slots.
  pullboardProcess(box, settingsRoot, ['settings', 'gateSlots', '2']);
  pullboardProcess(box, settingsRoot, ['settings', 'browserSlots', '2']);
  pullboardProcess(box, settingsRoot, ['settings', 'gate.shortSlots', '1']);
  assert.equal(JSON.parse(pullboardProcess(box, settingsRoot, ['settings', '--json'])).settings.gate.shortSlots, 1);
  assert.match(pullboardProcess(box, settingsRoot, ['settings']), /^gate\.shortSlots: 1$/mu, 'pullboard settings shows the value');

  await withNestedGroup(async add => {
    const holders = await wholeSuiteHolders(box, ['whole-one', 'whole-two'], add);
    const waiting = [];
    try {
      // Each waiter below is offered the free short slot on its first poll, so starting there would show at once.
      const ordinary = { marker: join(box.dir, 'ordinary.started'), release: join(box.dir, 'ordinary.release'), waiting: join(box.dir, 'ordinary.waiting') };
      ordinary.child = launchOrdinaryLease(box, settingsRoot, ordinary);
      waiting.push(ordinary);
      assert.equal(await waitFor(() => (existsSync(ordinary.marker) ? 'ran' : existsSync(ordinary.waiting) ? 'waiting' : false), 'an unnamed run to start or queue'),
        'waiting', 'a run that does not name its test files never takes the short slot, even with no browser');
      const wholeWaiter = { marker: join(box.dir, 'whole-waiter.started'), release: join(box.dir, 'whole-waiter.release') };
      wholeWaiter.child = add(launchTestRunner(box, probeSuite(box, 'whole-waiter'), [], wholeWaiter.marker, wholeWaiter.release));
      waiting.push(wholeWaiter);
      await waitFor(() => wholeWaiter.child.stderrText.includes('waiting for a gate slot:'), 'a third whole suite to queue');
      const directory = { marker: join(box.dir, 'directory.started'), release: join(box.dir, 'directory.release') };
      directory.child = add(launchTestRunner(box, shortProbeSuite(box, 'directory-run'), ['test/'], directory.marker, directory.release));
      waiting.push(directory);
      await waitFor(() => directory.child.stderrText.includes('waiting for a gate slot:'), 'a directory run to queue');
      const queued = JSON.parse(pullboardProcess(box, settingsRoot, ['resources', '--json'])).resources.find(resource => resource.name === 'gate').line;
      assert.deepEqual(queued.map(waiter => waiter.kind), ['fixture-ordinary', 'gate', 'seat-test']);
      assert.equal(queued[1].requestedSlot, undefined, 'a whole suite is never offered a short slot');
      assert.equal(queued[2].requestedSlot, undefined, 'a directory run is never offered a short slot');
      const shortRoot = shortProbeSuite(box, 'short-run');
      const short = { marker: join(box.dir, 'short.started'), release: join(box.dir, 'short.release') };
      short.child = add(launchTestRunner(box, shortRoot, ['--test-name-pattern', PROBE_PATTERN, 'test/short-probe.test.js'], short.marker, short.release));
      waiting.push(short);
      const outcome = await waitFor(() => (existsSync(short.marker) ? 'ran' : short.child.stderrText.includes('waiting for a gate slot:') ? 'waiting' : false), 'the named-file run to start or queue');
      assert.equal(outcome, 'ran', 'with gate.shortSlots 1 a named-file run starts while both gate slots hold whole suites');
      assert.deepEqual([ordinary, wholeWaiter, directory].map(run => existsSync(run.marker)), [false, false, false], 'the runs queued ahead of it still wait');

      const status = JSON.parse(pullboardProcess(box, settingsRoot, ['resources', '--json']));
      assert.equal(status.shortSlots, 1, 'pool status reports gate.shortSlots');
      const gate = status.resources.find(resource => resource.name === 'gate');
      assert.equal(gate.capacity, 2, 'short slots do not raise gateSlots');
      assert.deepEqual(gate.holders.map(holder => [holder.kind, holder.slot]).sort(), [['gate', 'gate'], ['gate', 'gate'], ['seat-test', 'short']],
        'pool status names the slot each run holds');
      const text = pullboardProcess(box, settingsRoot, ['resources']);
      const gateText = text.slice(text.indexOf('\ngate (machine'));
      assert.equal((gateText.match(/held by .*\(short slot, seat-test\)/gu) ?? []).length, 1, 'the text status names the short slot');
      assert.equal((gateText.match(/held by .*\(gate slot, gate, browser\)/gu) ?? []).length, 2, 'the text status names each gate slot');
      const reuse = wholeSuiteInheritance(box, settingsRoot, JSON.parse(readFileSync(short.marker, 'utf8')));
      assert.equal(reuse.stdout, 'SHORT_SLOT_FULL_SUITE', 'a whole suite cannot reuse a short lease from inside the short check');
    } finally {
      await releaseAll([...holders, ...waiting]);
    }
    for (const run of [...holders, ...waiting]) {
      const { code } = await run.child.closed;
      // Node refuses a directory operand once the run is admitted; only its queueing is under test here.
      if (run.child.stdoutText.includes('ERR_UNSUPPORTED_DIR_IMPORT')) assert.equal(code, 1);
      else assert.equal(code, 0, `${run.child.stderrText}${run.child.stdoutText}`);
    }

  });

  const off = fixture();
  const offRoot = gateRepo(off, 'settings-off');
  pullboardProcess(off, offRoot, ['settings', 'gateSlots', '2']);
  pullboardProcess(off, offRoot, ['settings', 'browserSlots', '2']);
  pullboardProcess(off, offRoot, ['settings', 'gate.shortSlots', '0']);
  await withNestedGroup(async add => {
    const offHolders = await wholeSuiteHolders(off, ['off-one', 'off-two'], add);
    const named = { marker: join(off.dir, 'named.started'), release: join(off.dir, 'named.release') };
    try {
      named.child = add(launchTestRunner(off, shortProbeSuite(off, 'named-off'), ['--test-name-pattern', PROBE_PATTERN, 'test/short-probe.test.js'], named.marker, named.release));
      const outcome = await waitFor(() => (existsSync(named.marker) ? 'ran' : named.child.stderrText.includes('waiting for a gate slot:') ? 'waiting' : false), 'the named-file run to start or queue');
      assert.equal(outcome, 'waiting', 'with gate.shortSlots 0 a named-file run waits for a gate slot, as before');
      const gate = JSON.parse(pullboardProcess(off, offRoot, ['resources', '--json'])).resources.find(resource => resource.name === 'gate');
      assert.equal(gate.line.length, 1);
      assert.equal(gate.line[0].requestedSlot, 'short-eligible', 'the waiting run is marked as one that names its files');
      writeFileSync(offHolders[0].release, 'release\n');
      await waitFor(() => existsSync(named.marker), 'the named-file run to start once a gate slot frees');
    } finally {
      await releaseAll(named.child ? [...offHolders, named] : offHolders);
    }
    for (const run of named.child ? [...offHolders, named] : offHolders) assert.equal((await run.child.closed).code, 0, `${run.child.stderrText}${run.child.stdoutText}`);
  });
});
