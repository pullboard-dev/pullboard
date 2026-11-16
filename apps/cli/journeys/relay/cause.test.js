/** The relay browser names the real cause of RELAY_UNAVAILABLE as a typed object, each with its one fix [H5,H17]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { relayUnavailableCause } from '../../../relay/index.js';

const unavailable = Object.assign(new Error('The relay did not answer.'), { code: 'RELAY_UNAVAILABLE' });

test('relay off names the machine and the command that turns it on [H5]', () => {
  const cause = relayUnavailableCause({ error: unavailable, relayOn: false, machine: 'm1' });
  assert.equal(cause.cause, 'relay_off');
  assert.equal(cause.machine, 'm1');
  assert.match(cause.fix, /pullboard relay on/u);
});

test('an excluded board names who and why when recorded, and says unknown when not [H5,H17]', () => {
  const recorded = relayUnavailableCause({ error: unavailable, machine: 'm1', excluded: { name: 'acme/app', by: 'person', reason: 'person relay off', at: '2026-11-01T00:00:00.000Z' } });
  assert.deepEqual([recorded.cause, recorded.by, recorded.reason, recorded.name], ['excluded', 'person', 'person relay off', 'acme/app']);
  assert.match(recorded.fix, /pullboard relay on/u);
  const legacy = relayUnavailableCause({ error: unavailable, machine: 'm1', excluded: { name: 'acme/app' } });
  assert.equal(legacy.reason, 'unknown historical exclusion');
  assert.equal(legacy.by, null);
});

test('an asleep machine reports its last seen time [H5]', () => {
  const cause = relayUnavailableCause({ error: unavailable, machine: 'm1', machines: [{ id: 'm1', label: 'Laptop', online: false, lastSeen: '2026-11-14T10:00:00.000Z' }] });
  assert.equal(cause.cause, 'asleep');
  assert.equal(cause.lastSeen, '2026-11-14T10:00:00.000Z');
  assert.ok(cause.fix);
});

test('a real network failure stays a connection problem [H5]', () => {
  const cause = relayUnavailableCause({ error: new TypeError('Failed to fetch'), relayOn: false, machine: 'm1', excluded: { name: 'acme/app' } });
  assert.equal(cause.cause, 'connection');
  assert.equal(cause.fix, null);
});
