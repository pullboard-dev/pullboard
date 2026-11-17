/** @pullboard-test-input source-cell packages/sync */
/** @pullboard-world-pin reads main.js to prove its prepareEngineMove call passes the behind-device options. With engine.nameBehindDevice on, the git sync move preparation passes the setting and the roster's engines to prepareEngineMove; off, it passes neither [H17,C7,#9830]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { behindOptions } from '../../src/io/behind.js';

const ON = { nameBehindDevice: true, behindDevices: [{ device: 'alpha', seat: 'mac-alpha', engine: 9 }] };

test('clause 1: with the caller passing the setting on, sync hands nameBehindDevice and the roster behindDevices on [H17,#9830]', async () => {
  assert.deepEqual(await behindOptions({ behindDeviceOptions: async () => ON }), ON);
});

test('clause 1: gitBoardOperation spreads those options into the prepareEngineMove options [H17,#9830]', () => {
  const source = readFileSync(new URL('../../src/io/main.js', import.meta.url), 'utf8');
  assert.match(source, /\.\.\.await behindOptions\(io\)/u);
  assert.match(source, /prepareEngineMove\(board, operation, args, moveOptions\)/u);
});

test('clause 2: with the setting off, no reader, or a reader that fails, sync passes neither option [H17,#9830]', async () => {
  assert.deepEqual(await behindOptions({}), {});
  assert.deepEqual(await behindOptions(undefined), {});
  assert.deepEqual(await behindOptions({ behindDeviceOptions: () => ({}) }), {});
  assert.deepEqual(await behindOptions({ behindDeviceOptions: () => { throw new Error('roster down'); } }), {});
});
