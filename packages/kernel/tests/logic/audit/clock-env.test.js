/** The clock/timers and env/config boundaries register in the adapter switch beside the network and key ones [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CLOCK_ENV_BOUNDARIES,
  KEY_BOUNDARIES,
  NETWORK_BOUNDARIES,
  auditAdapterEnvironment,
  selectBoundaryAdapter,
} from '../../../src/logic/audit.js';

const real = Object.freeze({ name: 'real' });
const fake = Object.freeze({ name: 'fake' });
const trapped = new Proxy({}, { get() { throw new Error('the fake selection read the real adapter'); } });

test('kernel.audit.clock-env-boundaries-select-real-or-fake: #9850 clause 1: clock and env register beside network, board-api, keys and github-npm and each selects real or fake per run and per test [C7]', () => {
  assert.deepEqual(CLOCK_ENV_BOUNDARIES, ['clock', 'env']);
  for (const boundary of [...NETWORK_BOUNDARIES, ...KEY_BOUNDARIES]) assert.equal(selectBoundaryAdapter(boundary, { fake, real, env: {} }), fake);
  for (const boundary of CLOCK_ENV_BOUNDARIES) {
    assert.equal(selectBoundaryAdapter(boundary, { fake, real, env: {} }), fake);
    assert.equal(selectBoundaryAdapter(boundary, { fake, real, env: { PULLBOARD_TEST_REAL: boundary } }), real);
    assert.equal(selectBoundaryAdapter(boundary, { fake, real, env: { PULLBOARD_TEST_REAL: 'git, ' + boundary } }), real);
    assert.equal(selectBoundaryAdapter(boundary, { fake, real, env: {}, mode: 'real' }), real);
    assert.equal(selectBoundaryAdapter(boundary, { fake, real, env: { PULLBOARD_TEST_REAL: 'all' }, mode: 'fake' }), fake);
    assert.equal(selectBoundaryAdapter(boundary, { fake, real: trapped, env: {} }), fake, 'the fake selection never touches the real adapter');
  }
});

test('kernel.audit.scheduled-audit-forces-clock-env-real: #9850 clause 2: the scheduled audit forces both boundaries real, and a run naming one boundary forces just that one [C7]', () => {
  const audit = auditAdapterEnvironment(true);
  for (const boundary of CLOCK_ENV_BOUNDARIES) {
    assert.equal(selectBoundaryAdapter(boundary, { fake, real, env: audit }), real);
    assert.equal(selectBoundaryAdapter(boundary, { fake, real, env: audit, mode: 'fake' }), real);
  }
  assert.equal(selectBoundaryAdapter('clock', { fake, real, env: { PULLBOARD_TEST_REAL: 'clock' } }), real);
  assert.equal(selectBoundaryAdapter('env', { fake, real, env: { PULLBOARD_TEST_REAL: 'clock' } }), fake);
  assert.equal(selectBoundaryAdapter('clock', { fake, real, env: { PULLBOARD_TEST_REAL: 'env' } }), fake);
  assert.throws(() => selectBoundaryAdapter('unregistered', { fake, real, env: audit }), TypeError);
});
