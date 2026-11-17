/** @pullboard-test-input source-cell packages/sync */
/** @pullboard-world-pin reads main.js to prove its prepareEngineMove call passes the behind-device options. With engine.nameBehindDevice on, the git sync move preparation passes the setting and the roster's engines to prepareEngineMove; off, it passes neither [H17,C7,#9830]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixtureBoard } from '../../../board/tests/fixtures/board.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../gate/tests/fixtures/child.js';
import { gitBoardOperation } from '../../index.js';
import { behindOptions } from '../../src/io/behind.js';

const ON = { nameBehindDevice: true, behindDevices: [{ device: 'alpha', seat: 'mac-alpha', engine: 9 }] };

test('sync.behind-device-pass.setting-on-hands-options: clause 1: with the caller passing the setting on, sync hands nameBehindDevice and the roster behindDevices on [H17,#9830]', async () => {
  assert.deepEqual(await behindOptions({ behindDeviceOptions: async () => ON }), ON);
});

test('sync.behind-device-pass.source-spreads-options: clause 1: gitBoardOperation spreads those options into the prepareEngineMove options [H17,#9830]', () => {
  const source = readFileSync(new URL('../../src/io/main.js', import.meta.url), 'utf8');
  assert.match(source, /\.\.\.await behindOptions\(io\)/u);
  assert.match(source, /prepareEngineMove\(board, operation, args, moveOptions\)/u);
});

test('sync.behind-device-pass.setting-off-hands-nothing: clause 2: with the setting off, no reader, or a reader that fails, sync passes neither option [H17,#9830]', async () => {
  assert.deepEqual(await behindOptions({}), {});
  assert.deepEqual(await behindOptions(undefined), {});
  assert.deepEqual(await behindOptions({ behindDeviceOptions: () => ({}) }), {});
  assert.deepEqual(await behindOptions({ behindDeviceOptions: () => { throw new Error('roster down'); } }), {});
});

const NEEDED = 1_000_000;
const DEVICES = { nameBehindDevice: true, behindDevices: [{ device: 'laptop', seat: 'core-3', engine: 10 }, { device: 'current', seat: 'core-4', engine: NEEDED }] };

/** A real board in a real git work tree with a bare origin, whose engine ports demand a newer engine than this one so prepareEngineMove refuses. */
function behindFixture(t) {
  const { root: folder } = privateFixtureFiles('pullboard-behind-pass-');
  const sh = (cwd, ...args) => runFixtureGit(args, { cwd, encoding: 'utf8' });
  sh(folder, 'init', '-q', '--bare', 'origin.git');
  const root = join(folder, 'work');
  sh(folder, 'init', '-q', 'work');
  sh(root, 'remote', 'add', 'origin', join(folder, 'origin.git'));
  sh(root, 'config', 'user.name', 'fixture');
  sh(root, 'config', 'user.email', 'fixture@example.invalid');
  sh(root, 'commit', '-q', '--allow-empty', '-m', 'chore: start');
  const board = fixtureBoard(t);
  const ports = board.enginePorts;
  board.enginePorts = { ...ports, operations: [...ports.operations, 'probe'], minimumOperationEngine: () => NEEDED };
  return { root, board };
}

/** The refusal gitBoardOperation raises for the probe move under the given ports. */
async function refusal(t, io) {
  const { root, board } = behindFixture(t);
  try { await gitBoardOperation(root, board, 'probe', [], io); } catch (error) { return error; }
  return assert.fail('the move was not refused');
}

test('sync.behind-device-pass.real-move-names-device: clause 1: a real gitBoardOperation with the setting on passes the roster to prepareEngineMove, whose refusal names the device behind [H17,#9830]', async t => {
  const error = await refusal(t, { behindDeviceOptions: async () => DEVICES });
  assert.equal(error.code, 'ENGINE_VERSION');
  assert.match(error.message, /laptop \(seat core-3\)/u);
  assert.doesNotMatch(error.message, /current/u);
});

test('sync.behind-device-pass.real-move-off-passes-nothing: clause 2: a real gitBoardOperation with the setting off, no reader, or a failing roster read passes no options, so the refusal stays plain [H17,#9830]', async t => {
  const plain = `[ENGINE_VERSION] probe requires engine version ${NEEDED};`;
  for (const io of [{ behindDeviceOptions: async () => ({}) }, {}, { behindDeviceOptions: () => { throw new Error('roster down'); } }]) {
    const error = await refusal(t, io);
    assert.equal(error.code, 'ENGINE_VERSION');
    assert.ok(error.message.startsWith(plain), error.message);
    assert.doesNotMatch(error.message, /laptop/u);
  }
});
