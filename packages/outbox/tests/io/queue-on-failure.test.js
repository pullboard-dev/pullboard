/** With relay.queueOnFailure on, a move on a linked board queues when the relay is down or answers 5xx, even with the outbox off [C7,#9410]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Refused } from '../../../kernel/light.js';
import { outboxQueueable } from '../../src/io/relay.js';

const LINKED = { mode: 'ordered', baselineAccepted: true };
const DOWN = new Refused('RELAY_UNAVAILABLE', 'the relay did not answer');
const UNAVAILABLE_503 = Object.assign(new Refused('RELAY_RESPONSE', 'the relay answered 503'), { httpStatus: 503 });
const REFUSED_AUTH = new Refused('AUTH_REQUIRED', 'sign in again');

/** Decide with the board's relay.outbox off and the machine's relay.queueOnFailure as given. */
function queueable(error, queueOnFailure, extra = {}) {
  const saved = process.env.PULLBOARD_RELAY_TOKEN;
  delete process.env.PULLBOARD_RELAY_TOKEN;
  try {
    return outboxQueueable({ ...LINKED }, error, 'addItem', { relayOutbox: () => false, relayQueueOnFailure: () => queueOnFailure, ...extra }, []);
  } finally { if (saved !== undefined) process.env.PULLBOARD_RELAY_TOKEN = saved; }
}

test('clause 1: with relay.queueOnFailure on and relay.outbox off, an add against a down relay and against a 503 queues [C7,#9410]', () => {
  assert.equal(queueable(DOWN, true), true, 'a down relay queues the add');
  assert.equal(queueable(UNAVAILABLE_503, true), true, 'a 503 queues the add');
});

test('clause 1: with queueOnFailure on, a definite refusal, an unlinked state and an environment session still do not queue [C7,#9410]', () => {
  assert.equal(queueable(REFUSED_AUTH, true), false);
  assert.equal(outboxQueueable({ mode: 'ordered', baselineAccepted: false }, DOWN, 'addItem', { relayQueueOnFailure: () => true }, []), false);
  assert.equal(outboxQueueable({ ...LINKED, environment: { agent: 'x' } }, DOWN, 'addItem', { relayQueueOnFailure: () => true }, []), false);
});

test('clause 2: with the setting off (default) and the outbox off, the same failures do not queue and refuse as today [C7,#9410]', () => {
  assert.equal(queueable(DOWN, false), false);
  assert.equal(queueable(UNAVAILABLE_503, false), false);
  assert.equal(outboxQueueable({ ...LINKED }, DOWN, 'addItem', { relayOutbox: () => false }, []), false, 'no relayQueueOnFailure reader at all');
  assert.equal(queueable(DOWN, false, { relayOutbox: () => true }), true, 'relay.outbox on queues exactly as before');
});

test('clause 2: a throwing setting reader never queues [C7,#9410]', () => {
  assert.equal(queueable(DOWN, true, { relayQueueOnFailure() { throw new Error('private configuration unavailable'); } }), false);
});
