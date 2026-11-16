/** The relay roster lists each device's recorded engine, or null when the relay recorded none [H17]. @pullboard-test-input source-cell link */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { boardPhones } from '../../../src/io/relay/roster.js';
import { joinedComputers } from '../../../src/io/relay/roster.js';

const BOARD = 'a'.repeat(32);
const PHONE_A = 'device-' + '1'.repeat(32);
const PHONE_B = 'device-' + '2'.repeat(32);
const PHONE_C = 'device-' + '3'.repeat(32);

/** Serve fixed roster documents on a loopback port; return the state a roster read needs and a closer. */
async function relay() {
  const answers = {
    '/api/v1/devices': { version: 1, devices: [
      { deviceId: PHONE_A, seen: 5, engine: 7 },
      { deviceId: PHONE_B, seen: 6 },
      { deviceId: PHONE_C, seen: 7, engine: 'seven' },
    ] },
    ['/auth/machines?board=' + BOARD]: { version: 1, machines: [
      { machine: 'mac-alpha', name: 'alpha', created: 1, seen: 2, engine: 9 },
      { machine: 'mac-beta', name: 'beta', created: 1, seen: 2 },
      { machine: 'mac-self', name: 'self', created: 1, seen: 2, engine: 4 },
    ] },
  };
  const server = createServer((req, res) => {
    const body = answers[req.url];
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body ?? { error: 'missing' }));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const state = { url: 'http://127.0.0.1:' + server.address().port, token: 'pm_' + 'x'.repeat(43), board: BOARD, machine: 'mac-self' };
  return { state, close: () => new Promise(done => server.close(done)) };
}

test('clause 1: boardPhones and joinedComputers return the recorded engine integer, or null when none [H17]', async () => {
  const { state, close } = await relay();
  try {
    const phones = await boardPhones(state);
    assert.deepEqual(phones.map(phone => [phone.deviceId, phone.engine]), [[PHONE_A, 7], [PHONE_B, null], [PHONE_C, null]]);
    const computers = await joinedComputers(state);
    assert.deepEqual(computers.map(computer => [computer.machine, computer.engine]), [['mac-alpha', 9], ['mac-beta', null]]);
  } finally {
    await close();
  }
});
