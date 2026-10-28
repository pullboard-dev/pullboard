/** Machine-wide gate capacity settings through the actual CLI [O5,O6]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { runFixtureChild } from './fixture-child.js';
import { installRegistrationProbeStandIn } from './runner-ssh-fixture.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const MACHINE_HOME_MODULE = resolve(import.meta.dirname, '../src/machine-home.js');

/** Run settings in an isolated machine home, returning its structured CLI result. */
function settings(home, ...args) {
  return runFixtureChild(process.execPath, [BIN, 'settings', ...args, '--json'], {
    encoding: 'utf8', env: { ...process.env, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: home },
  });
}

test('[O5,O6] gateSlots defaults to two, reads and sets atomically, and refuses invalid values', () => {
  const home = mkdtempSync(join(tmpdir(), 'pullboard-settings-'));
  try {
    const initial = settings(home);
    assert.equal(initial.status, 0, initial.stderr);
    assert.equal(JSON.parse(initial.stdout).settings.gateSlots, 2);

    const changed = settings(home, 'gateSlots', '3');
    assert.equal(changed.status, 0, changed.stderr);
    assert.equal(JSON.parse(changed.stdout).settings.gateSlots, 3);
    assert.equal(JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')).gateSlots, 3);
    assert.equal(JSON.parse(settings(home).stdout).settings.gateSlots, 3);

    const saved = readFileSync(join(home, 'settings.json'), 'utf8');
    for (const [value, code] of [['0', 'BAD_GATE_SLOTS'], ['abc', 'USAGE']]) {
      const refusedSet = settings(home, 'gateSlots', value);
      assert.equal(readFileSync(join(home, 'settings.json'), 'utf8'), saved, `${value} leaves settings.json unchanged`);
      assert.equal(refusedSet.status, 1, `${value}: ${refusedSet.stdout}${refusedSet.stderr}`);
      const error = JSON.parse(refusedSet.stdout).error;
      assert.equal(error.code, code);
      if (value === '0') assert.match(error.message, /registered runner; run pullboard runner add/u);
    }

    writeFileSync(join(home, 'settings.json'), JSON.stringify({ gateSlots: 0 }));
    const refused = settings(home);
    assert.equal(refused.status, 1);
    assert.equal(JSON.parse(refused.stdout).error.code, 'BAD_GATE_SLOTS');

    writeFileSync(join(home, 'settings.json'), saved);
    const bin = join(home, 'bin');
    mkdirSync(bin);
    installRegistrationProbeStandIn({ bin });
    const runner = runFixtureChild(process.execPath, [BIN, 'runner', 'add', 'settings-fixture.invalid', '--slots', '1', '--browser', '1', '--json'], {
      encoding: 'utf8', env: { ...process.env, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: home, PATH: `${bin}:${process.env.PATH}` },
    });
    assert.equal(runner.status, 0, `${runner.stdout}${runner.stderr}`);
    const browserZero = settings(home, 'browserSlots', '0');
    assert.equal(browserZero.status, 0, `${browserZero.stdout}${browserZero.stderr}`);
    const gateZero = settings(home, 'gateSlots', '0');
    assert.equal(gateZero.status, 0, `${gateZero.stdout}${gateZero.stderr}`);
    assert.equal(JSON.parse(gateZero.stdout).settings.gateSlots, 0);
    assert.equal(JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')).gateSlots, 0);
    assert.equal(JSON.parse(settings(home).stdout).settings.gateSlots, 0, 'a registered runner makes zero local slots valid');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('[Q4] the machine pool ignores board and HOME overrides unless explicitly selected', () => {
  const script = `import { machineHome } from ${JSON.stringify(MACHINE_HOME_MODULE)}; process.stdout.write(machineHome());`;
  const env = { ...process.env, HOME: '/private/home', PULLBOARD_HOME: '/private/board' };
  delete env.PULLBOARD_MACHINE_HOME;
  delete env.PULLBOARD_ACCOUNT_HOME;
  const defaultHome = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env });
  assert.equal(defaultHome.status, 0, defaultHome.stderr);
  assert.equal(defaultHome.stdout, join(userInfo().homedir, '.pullboard'));
  const account = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...env, PULLBOARD_ACCOUNT_HOME: '/private/account' } });
  assert.equal(account.stdout, join('/private/account', '.pullboard'), 'a test run substitutes its own account home [C7]');

  const override = join(tmpdir(), 'pullboard-private-machine-home');
  const privateHome = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', env: { ...env, PULLBOARD_MACHINE_HOME: override },
  });
  assert.equal(privateHome.status, 0, privateHome.stderr);
  assert.equal(privateHome.stdout, resolve(override));
});

test('the settings API reports every setting with its scope, value, default and source and never a secret [O5,O6]', async () => {
  const { proveSettingsApi } = await import('./settings-api-fixture.js');
  await proveSettingsApi();
});

/** Board-owned settings keep native move evidence, independent of machine-wide admission settings [R1,R2,H16]. */
test('a line setting change is a recorded move with its reason and its range [R1,R2,H16]', async t => {
  const { createE2eHelpers } = await import('./e2e-helpers.js');
  const store = await import('../src/board.js');
  const { exportBoard, importBoard } = await import('../src/exchange.js');
  const { prepareEngineMove, applyRelayMove, appliedSequence } = await import('../src/engine.js');
  const fixtures = createE2eHelpers();
  let board, replica;
  t.after(() => { if (replica) store.closeBoard(replica); if (board) store.closeBoard(board); fixtures.cleanup(); });
  const box = fixtures.project('true');
  const initial = box.run(box.repo, 'settings', 'line', '--json');
  const numbers = { windowMinutes: 60, activeReviewers: 2, reviewWaitMedianMinutes: 40 };
  const changed = box.run(box.repo, 'settings', 'line', 'reviewsFirst', 'on', '--reason', 'Review waiting exceeds the target',
    '--window', JSON.stringify(numbers), '--json');
  assert.equal(changed.code, 0, `a board setting change succeeds: ${changed.err}${changed.out}`);
  assert.equal(initial.code, 0, initial.err);
  const defaults = { order: false, focusMilestone: false, collisionFreeBatch: false, reviewsFirst: false, requireReviewFamilies: false, wipPerReviewer: false, barReady: false,
    'bar.check': false, takeoverMinutes: false,
    landingBatchSize: false, landingCadenceMinutes: false };
  assert.deepEqual(JSON.parse(initial.out).lineSettings, defaults, 'all line controls start off, not silently enabled by a machine file');
  assert.equal(JSON.parse(changed.out).lineSettings.reviewsFirst, true);
  board = store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  replica = store.openBoard(join(box.dir, 'line-replay.sqlite'));
  importBoard(replica, exportBoard(board));
  const first = store.events(board).findLast(event => event.event_kind === 'line_setting');
  assert.ok(first, 'the actual CLI records a native board event, not only a local settings file');
  assert.deepEqual(JSON.parse(first.event_detail), { key: 'reviewsFirst', value: true,
    reason: 'Review waiting exceeds the target', window: numbers, model: 'unknown' });
  assert.equal(first.event_by, 'coordinator');
  const values = [['focusMilestone', '0.9.3'], ['focusMilestone', false], ['order', true], ['order', false], ['reviewsFirst', false], ['wipPerReviewer', 1.5], ['wipPerReviewer', 3],
    ['barReady', true], ['bar.check', true], ['collisionFreeBatch', true], ['collisionFreeBatch', false],
    ['takeoverMinutes', 15], ['takeoverMinutes', 60], ['landingBatchSize', 1], ['landingBatchSize', 8],
    ['landingCadenceMinutes', 5], ['landingCadenceMinutes', 30]];
  let sequence = appliedSequence(board);
  for (const [key, value] of values) {
    const move = prepareEngineMove(board, 'setLineSetting', [{ agentId: 'coordinator', key, value,
      reason: 'Measured fixture policy change', window: numbers }], { id: `line-setting-${++sequence}`, actor: 'coordinator' });
    const options = { sequence, at: `2026-10-24T01:${String(sequence).padStart(2, '0')}:00.000Z`, kind: 'move',
      sender: { kind: 'agent', userId: 'line-fixture', agent: 'coordinator' } };
    const outcomes = [board, replica].map(copy => applyRelayMove(copy, move, options));
    assert.deepEqual(outcomes[0], outcomes[1]);
    assert.ok(!outcomes[0].error, JSON.stringify(outcomes[0]));
    assert.equal(store.lineSettings(board)[key], value);
    assert.deepEqual(store.lineSettings(replica), store.lineSettings(board));
  }
  for (const [key, value] of [['wipPerReviewer', 1.49], ['wipPerReviewer', 3.01], ['takeoverMinutes', 14],
    ['takeoverMinutes', 61], ['landingBatchSize', 0], ['landingBatchSize', 9], ['landingBatchSize', 1.5],
    ['focusMilestone', ''], ['focusMilestone', 'two\nlines'], ['focusMilestone', true], ['landingCadenceMinutes', 4], ['landingCadenceMinutes', 31], ['reviewsFirst', 1], ['order', 1]]) {
    const before = store.events(board).length;
    assert.throws(() => store.setLineSetting(board, { agentId: 'coordinator', key, value, reason: 'Invalid limit', window: numbers }), /LINE_SETTING_RANGE/u);
    assert.equal(store.events(board).length, before, 'a refused value appends no successful setting event');
  }
});
