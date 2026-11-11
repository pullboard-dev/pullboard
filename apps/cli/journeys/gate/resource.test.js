/** Gate commands, item checks and verify share the machine queue in order, and settings and resources print the short-slot state, through the real CLI [Q1,Q2,Q4,C7,V18]. */
import assert from 'node:assert/strict';
import { startFixtureChild as spawn } from '../../tests/fixtures/child.js';
import { runFixtureChild as spawnSync } from '../../tests/fixtures/child.js';
import { chmodSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { fixtureAddArgv } from '../../tests/fixtures/testkit.js';
import { fixtureJoinArgv } from '../../tests/fixtures/testkit.js';
import { awaitNestedPhase } from '../../../../packages/gate/index.js';
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
import { events } from '../../tests/fixtures/gate/resource.js';
import { PROBE_PATTERN } from '../../tests/fixtures/gate/resource.js';
import { reapFixtures } from '../../tests/fixtures/gate/resource.js';
import { trackChild } from '../../tests/fixtures/gate/resource.js';

const BIN = resolve(import.meta.dirname, '../../pullboard.js');

after(reapFixtures);

/** Run one pullboard command in a fixture, require success, and return its output. */
function pullboard(box, root, args) {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd: root, env: box.env, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.failure ?? ''}${result.stdout}${result.stderr}`);
  return result.stdout;
}

/** Launch a real gate CLI in its own process group and collect its output. */
function launch(box, root, args = ['gate']) {
  const child = spawn(process.execPath, [BIN, ...args], { cwd: root, env: box.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return trackChild(child);
}

/** Create a real claimed item whose check can pause after admission and leave an execution marker. */
function checkProject(box, { releaseCheck = null } = {}) {
  const root = join(box.dir, 'check-project');
  const runner = join(box.dir, 'check-runner');
  const script = join(box.dir, 'item-check.cjs');
  const shims = join(box.dir, 'bin');
  mkdirSync(shims);
  writeFileSync(join(shims, 'pullboard'), `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`);
  chmodSync(join(shims, 'pullboard'), 0o755);
  box.env.PATH = `${shims}:${box.env.PATH}`;
  mkdirSync(root);
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: box.env }).status, 0);
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({
    gate: 'true',
    landing: { perItem: false, manualOverride: true },
    lanes: { web: { owns: ['web/'], specs: ['G1'] }, api: { owns: ['api/'], specs: ['G2'] } },
  }));
  writeFileSync(join(root, 'SPEC.md'), '# Queue fixture\n\n## G · Goals\n- G1 [approved, must] The check runs. | gate: test -f web/result.txt\n- G2 [approved, must] The API responds. | gate: test -f api/result.txt\n');
  assert.equal(spawnSync('git', ['add', '-A'], { cwd: root, env: box.env }).status, 0);
  assert.equal(spawnSync('git', ['commit', '-q', '-m', 'chore: queue fixture'], { cwd: root, env: box.env }).status, 0);
  const initialized = spawnSync(process.execPath, [BIN, 'init'], { cwd: root, env: box.env, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.equal(spawnSync('git', ['worktree', 'add', '-q', runner, '-b', 'web/runner'], { cwd: root, env: box.env }).status, 0);
  const joined = spawnSync(process.execPath, [...fixtureJoinArgv(BIN), 'web', '--model', 'fixture-model'], { cwd: runner, env: box.env, encoding: 'utf8' });
  assert.equal(joined.status, 0, joined.stderr);
  writeFileSync(script, releaseCheck
    ? `const fs = require('node:fs');\n(async () => {\n  fs.appendFileSync(${JSON.stringify(box.events)}, 'item check start\\n');\n  while (!fs.existsSync(${JSON.stringify(releaseCheck)})) await new Promise(done => setTimeout(done, 10));\n  fs.appendFileSync(${JSON.stringify(box.events)}, 'item check\\n');\n  process.exitCode = fs.existsSync('web/result.txt') ? 0 : 1;\n})();\n`
    : `const fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(box.events)}, 'item check\\n'); process.exitCode = fs.existsSync('web/result.txt') ? 0 : 1;\n`);
  if (releaseCheck) writeFileSync(releaseCheck, 'baseline runs without a hold\n');
  const added = spawnSync(process.execPath, [...fixtureAddArgv(BIN), 'web', 'Check item', '--specs', 'G1', '--route', 'mid', '--criterion', 'the item check runs', '--check', `node '${script}'`, '--wait', '--brief', 'Files: web/result.txt\nTest: run the item check and observe its result.'], { cwd: root, env: box.env, encoding: 'utf8' });
  assert.equal(added.status, 0, added.stderr);
  assert.equal(spawnSync(process.execPath, [BIN, 'claim', '1'], { cwd: runner, env: box.env }).status, 0);
  if (releaseCheck) rmSync(releaseCheck, { force: true });
  writeFileSync(box.events, '');
  return { root, runner };
}

/** Set the fixture machine pool to one gate slot before starting holders. */
function setOneGateSlot(box, root) {
  const configured = spawnSync(process.execPath, [BIN, 'settings', 'gateSlots', '1'], { cwd: root, env: box.env, encoding: 'utf8' });
  assert.equal(configured.status, 0, configured.failure ?? configured.stderr);
}

test('[Q1,Q2,V18] an older item check keeps its place ahead of a later ordinary gate', async () => {
  const box = fixture();
  const release = join(box.dir, 'release-holder');
  const checkRelease = join(box.dir, 'release-item-check');
  const firstRoot = gateRepo(box, 'slot-holder', 0.1, release);
  const nextRoot = gateRepo(box, 'ordinary-gate', 0.15);
  const { root, runner } = checkProject(box, { releaseCheck: checkRelease });
  assert.equal(spawnSync(process.execPath, [BIN, 'settings', 'gateSlots', '1'], { cwd: firstRoot, env: box.env }).status, 0);

  const first = launch(box, firstRoot);
  await waitFor(() => events(box).includes('slot-holder start') && !events(box).includes('slot-holder end'), 'the first gate to hold the only slot');
  const check = launch(box, runner, ['check', '1', '--yes']);
  await waitFor(() => check.stdoutText.includes('place 1') || check.exitCode !== null, 'the item check to queue behind the running gate');
  assert.ok(check.stdoutText.includes('place 1'), 'the item check prints its queued gate-slot position');
  assert.match(check.stdoutText, /gate waiting:/);
  assert.deepEqual(events(box), ['slot-holder start'], 'the item check command has not started while the gate holds the slot');
  const ordinary = launch(box, nextRoot);
  await waitFor(() => /place [12]/u.test(ordinary.stdoutText), 'the later ordinary gate to enter the queue');
  assert.ok(ordinary.stdoutText.includes('place 2'), 'the later ordinary gate stays second behind the item check');
  assert.deepEqual(events(box), ['slot-holder start'], 'neither queued command runs before the holder releases');

  writeFileSync(release, 'release\n');
  await waitFor(() => events(box).includes('item check start'), 'the older item check to acquire the released slot');
  assert.equal(events(box).includes('ordinary-gate start'), false, 'the later ordinary gate stays behind the older item check');
  writeFileSync(checkRelease, 'release\n');
  await waitFor(() => events(box).includes('item check'), 'the older item check to release its slot');
  await waitFor(() => events(box).includes('ordinary-gate start'), 'the later ordinary gate to acquire after the item check');
  await waitFor(() => events(box).includes('ordinary-gate end'), 'the ordinary gate to finish');
  const [firstResult, ordinaryResult, checkResult] = await Promise.all([first.closed, ordinary.closed, check.closed]);
  assert.equal(firstResult.code, 0);
  assert.equal(ordinaryResult.code, 0, ordinary.stderrText);
  assert.equal(checkResult.code, 1, check.stderrText);
  assert.deepEqual(events(box), ['slot-holder start', 'slot-holder end', 'item check start', 'item check', 'ordinary-gate start', 'ordinary-gate end']);

  mkdirSync(join(runner, 'web'));
  writeFileSync(join(runner, 'web', 'result.txt'), 'ready\n');
  assert.equal(spawnSync('git', ['add', 'web/result.txt'], { cwd: runner, env: box.env }).status, 0);
  const commit = spawnSync('git', ['commit', '-q', '-m', 'feat(web): queue item proof [G1]'], { cwd: runner, env: box.env, encoding: 'utf8' });
  assert.equal(commit.status, 0, commit.stderr);
  const submitted = spawnSync(process.execPath, [BIN, 'submit', '1', '--wait', '--no-next'], { cwd: runner, env: box.env, encoding: 'utf8' });
  assert.equal(submitted.status, 0, submitted.stderr);
  rmSync(checkRelease, { force: true });
  const review = join(box.dir, 'check-review');
  const itemCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: runner, env: box.env, encoding: 'utf8' }).stdout.trim();
  assert.equal(spawnSync('git', ['worktree', 'add', '-q', '--detach', review, itemCommit], { cwd: root, env: box.env }).status, 0);
  const reviewBox = { ...box, env: { ...box.env, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'gate-resource-reviewer' } };
  const reviewer = spawnSync(process.execPath, [...fixtureJoinArgv(BIN), 'api', '--model', 'fixture-reviewer'], { cwd: review, env: reviewBox.env, encoding: 'utf8' });
  assert.equal(reviewer.status, 0, reviewer.stderr);

  // A moved trunk keeps verify from reusing the submit proof, so its own check must queue for the gate slot.
  // The move reaches a file the item changed (same bytes, so it composes cleanly); a move elsewhere leaves the sealed receipt standing.
  mkdirSync(join(root, 'web'));
  writeFileSync(join(root, 'web', 'result.txt'), 'ready\n');
  assert.equal(spawnSync('git', ['add', 'web/result.txt'], { cwd: root, env: box.env }).status, 0);
  const moved = spawnSync('git', ['commit', '-q', '-m', 'chore: move main'], { cwd: root, env: box.env, encoding: 'utf8' });
  assert.equal(moved.status, 0, moved.stderr);
  writeFileSync(box.events, '');
  const verifyRelease = join(box.dir, 'release-verify-holder');
  const verifyHolderRoot = gateRepo(box, 'verify-holder', 0.1, verifyRelease);
  const verifyFocusedRoot = probeSuite(box, 'verify-focused-suite');
  const verifyFocusedMarker = join(box.dir, 'verify-focused.started');
  const verifyFocusedRelease = join(box.dir, 'release-verify-focused');
  const verifyHolder = launch(box, verifyHolderRoot);
  await waitFor(() => events(box).includes('verify-holder start') && !events(box).includes('verify-holder end'), 'a gate to hold the slot before accepting an item');
  const verify = launch(reviewBox, review, ['verify', '1', 'accept', '--no-next', '--note', 'queue fixture']);
  await waitFor(() => verify.stdoutText.includes('place 1') || verify.exitCode !== null, 'verify accept to queue for the gate slot');
  assert.ok(verify.stdoutText.includes('place 1'), `verify accept prints its queued gate-slot position: ${verify.stdoutText}${verify.stderrText}`);
  assert.match(verify.stdoutText, /gate waiting:/);
  const verifyNext = launchTestRunner(box, verifyFocusedRoot, ['--test-name-pattern', PROBE_PATTERN, 'test/probe.test.js'], verifyFocusedMarker, verifyFocusedRelease);
  await awaitNestedPhase(verifyNext, async () => {
    await waitFor(() => /waiting for a gate slot:/u.test(verifyNext.stderrText) || verifyNext.exitCode !== null, 'the later focused run to enter the queue');
    assert.equal(existsSync(verifyFocusedMarker), false, 'the focused run has not started while the holder owns the slot');
    assert.equal(events(box).includes('item check'), false);
    writeFileSync(verifyRelease, 'release\n');
    await waitFor(() => events(box).includes('item check start'), 'the older verify check to acquire the released slot');
    assert.equal(existsSync(verifyFocusedMarker), false, 'the later focused run stays behind review');
    writeFileSync(checkRelease, 'release\n');
    await waitFor(() => events(box).includes('item check'), 'the verify check to release its slot');
    await waitFor(() => existsSync(verifyFocusedMarker), 'the focused run to start after review releases');
    const verifyRun = await verify.closed;
    assert.equal(verifyRun.code, 0, `${verify.stderrText}${verify.stdoutText}`);
    writeFileSync(verifyFocusedRelease, 'release\n');
    const [verifyHolderResult, verifyNextResult] = await Promise.all([verifyHolder.closed, verifyNext.closed]);
    assert.equal(verifyHolderResult.code, 0);
    assert.equal(verifyNextResult.code, 0, verifyNext.stderrText + verifyNext.stdoutText);
    assert.deepEqual(events(box), ['verify-holder start', 'verify-holder end', 'item check start', 'item check']);
  });
});

test('a short check never waits behind whole suites [C7]', async () => {
  const box = fixture();
  const settingsRoot = gateRepo(box, 'settings-view');
  assert.equal(JSON.parse(pullboard(box, settingsRoot, ['settings', '--json'])).settings.gate.shortSlots, 0, 'gate.shortSlots defaults to 0');
  assert.match(pullboard(box, settingsRoot, ['settings']), /^gate\.shortSlots: 0 \(off/mu, 'pullboard settings shows the default');
  const refused = spawnSync(process.execPath, [BIN, 'settings', 'gate.shortSlots', 'two'], { cwd: settingsRoot, env: box.env, encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  assert.match(`${refused.stdout}${refused.stderr}`, /BAD_SHORT_SLOTS/u);
  // Whole suites take a browser slot too; two of them fill a two-slot gate only with two browser slots.
  pullboard(box, settingsRoot, ['settings', 'gateSlots', '2']);
  pullboard(box, settingsRoot, ['settings', 'browserSlots', '2']);
  pullboard(box, settingsRoot, ['settings', 'gate.shortSlots', '1']);
  assert.equal(JSON.parse(pullboard(box, settingsRoot, ['settings', '--json'])).settings.gate.shortSlots, 1);
  assert.match(pullboard(box, settingsRoot, ['settings']), /^gate\.shortSlots: 1$/mu, 'pullboard settings shows the value');

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
      const queued = JSON.parse(pullboard(box, settingsRoot, ['resources', '--json'])).resources.find(resource => resource.name === 'gate').line;
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

      const status = JSON.parse(pullboard(box, settingsRoot, ['resources', '--json']));
      assert.equal(status.shortSlots, 1, 'pool status reports gate.shortSlots');
      const gate = status.resources.find(resource => resource.name === 'gate');
      assert.equal(gate.capacity, 2, 'short slots do not raise gateSlots');
      assert.deepEqual(gate.holders.map(holder => [holder.kind, holder.slot]).sort(), [['seat-test', 'short'], ['gate', 'gate'], ['gate', 'gate']],
        'pool status names the slot each run holds');
      const text = pullboard(box, settingsRoot, ['resources']);
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
  pullboard(off, offRoot, ['settings', 'gateSlots', '2']);
  pullboard(off, offRoot, ['settings', 'browserSlots', '2']);
  pullboard(off, offRoot, ['settings', 'gate.shortSlots', '0']);
  await withNestedGroup(async add => {
    const offHolders = await wholeSuiteHolders(off, ['off-one', 'off-two'], add);
    const named = { marker: join(off.dir, 'named.started'), release: join(off.dir, 'named.release') };
    try {
      named.child = add(launchTestRunner(off, shortProbeSuite(off, 'named-off'), ['--test-name-pattern', PROBE_PATTERN, 'test/short-probe.test.js'], named.marker, named.release));
      const outcome = await waitFor(() => (existsSync(named.marker) ? 'ran' : named.child.stderrText.includes('waiting for a gate slot:') ? 'waiting' : false), 'the named-file run to start or queue');
      assert.equal(outcome, 'waiting', 'with gate.shortSlots 0 a named-file run waits for a gate slot, as before');
      const gate = JSON.parse(pullboard(off, offRoot, ['resources', '--json'])).resources.find(resource => resource.name === 'gate');
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
