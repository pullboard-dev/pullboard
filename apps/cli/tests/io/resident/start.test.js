/** The resident board starts through the reachable launcher, as the lander does [C7,#5760]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RESIDENT_ENTRY } from '../../../src/io/resident/client.js';
import { startResident } from '../../../src/io/resident/client.js';

const place = { socket: '/tmp/x.sock', pid: '/tmp/x.pid', home: '/nonexistent-home' };

test('clause 1: the resident board starts through the launcher that runs a launchd job and falls back to a detached spawn [C7]', async () => {
  const calls = [];
  await startResident(place, '/entry.js', 'v1', { A: 'b' }, async (command, args, options) => { calls.push({ command, args, options }); return { pid: 1, launchd: true }; });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args, [RESIDENT_ENTRY, place.socket, '/entry.js', 'v1', place.pid]);
  assert.equal(calls[0].options.cwd, process.cwd(), 'a missing home keeps the working folder');
  assert.deepEqual(calls[0].options.env, { A: 'b' });
});

test('clause 1: a launcher that throws never fails the command in hand [C7]', async () => {
  await startResident(place, '/entry.js', 'v1', {}, () => { throw new Error('no launchd'); });
});
