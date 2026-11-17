/** @pullboard-test-input source-cell outbox kernel */
/** With relay.queueOnFailure on, a key or sign-in failure queues on a linked ordered board [C7,#9892]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Refused } from '../../../kernel/light.js';
import { outboxQueueable } from '../../src/io/relay.js';

const LINKED = { mode: 'ordered', baselineAccepted: true };
const KEY_CODES = ['SEAL_AUTH_FAILED', 'SEAL_KEY', 'RELAY_KEY_MISSING'];

/** Decide with relay.outbox off and relay.queueOnFailure as given. */
function queueable(code, queueOnFailure, state = LINKED) {
  const saved = process.env.PULLBOARD_RELAY_TOKEN;
  delete process.env.PULLBOARD_RELAY_TOKEN;
  try {
    return outboxQueueable({ ...state }, new Refused(code, 'x'), 'addItem', { relayOutbox: () => false, relayQueueOnFailure: () => queueOnFailure }, []);
  } finally { if (saved !== undefined) process.env.PULLBOARD_RELAY_TOKEN = saved; }
}

test('clause 1: with relay.queueOnFailure on, SEAL_AUTH_FAILED, SEAL_KEY and RELAY_KEY_MISSING queue on a linked ordered board [C7,#9892]', () => {
  for (const code of KEY_CODES) assert.equal(queueable(code, true), true, code);
});

test('clause 2: AUTH_REQUIRED queues with the setting on, and none of these queue with it off [C7,#9892]', () => {
  assert.equal(queueable('AUTH_REQUIRED', true), true);
  for (const code of [...KEY_CODES, 'AUTH_REQUIRED']) assert.equal(queueable(code, false), false, code);
});

test('clause 3: an unlinked board and an environment session still do not queue [C7,#9892]', () => {
  for (const state of [{ mode: 'ordered', baselineAccepted: false }, { ...LINKED, environment: { agent: 'x' } }]) {
    for (const code of [...KEY_CODES, 'AUTH_REQUIRED']) assert.equal(queueable(code, true, state), false, code);
  }
});
