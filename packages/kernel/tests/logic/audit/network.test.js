/** The network/relay and board HTTP API boundaries select a real or fake adapter per run and per test, and the audit forces both real [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  NETWORK_BOUNDARIES,
  auditAdapterEnvironment,
  selectBoundaryAdapter,
} from '../../../src/logic/audit.js';

const real = Object.freeze({ name: 'real' });
const fake = Object.freeze({ name: 'fake' });

test('kernel.audit.network-boundary-selects-real-or-fake: #9856 clause 1: the network/relay boundary selects real or fake per run and per test [C7]', () => {
  assert.ok(NETWORK_BOUNDARIES.includes('network'));
  assert.equal(selectBoundaryAdapter('network', { fake, real, env: {} }), fake);
  assert.equal(selectBoundaryAdapter('network', { fake, real, env: { PULLBOARD_TEST_REAL: 'network' } }), real);
  assert.equal(selectBoundaryAdapter('network', { fake, real, env: { PULLBOARD_TEST_REAL: 'board-api' } }), fake);
  assert.equal(selectBoundaryAdapter('network', { fake, real, env: { PULLBOARD_TEST_REAL: 'all' } }), real);
  assert.equal(selectBoundaryAdapter('network', { fake, real, env: {}, mode: 'real' }), real);
  assert.equal(selectBoundaryAdapter('network', { fake, real, env: { PULLBOARD_TEST_REAL: 'all' }, mode: 'fake' }), fake);
  assert.throws(() => selectBoundaryAdapter('network', { fake, real, mode: 'both' }), TypeError);
  assert.throws(() => selectBoundaryAdapter('network', { fake, env: {} }), TypeError);
  assert.throws(() => selectBoundaryAdapter('nonesuch', { fake, real, env: {} }), TypeError);
});

test('kernel.audit.board-api-boundary-selects-real-or-fake: #9856 clause 2: the board HTTP API boundary selects real or fake the same way [C7]', () => {
  assert.ok(NETWORK_BOUNDARIES.includes('board-api'));
  assert.equal(selectBoundaryAdapter('board-api', { fake, real, env: {} }), fake);
  assert.equal(selectBoundaryAdapter('board-api', { fake, real, env: { PULLBOARD_TEST_REAL: 'git, board-api' } }), real);
  assert.equal(selectBoundaryAdapter('board-api', { fake, real, env: { PULLBOARD_TEST_REAL: 'network' } }), fake);
  assert.equal(selectBoundaryAdapter('board-api', { fake, real, env: { PULLBOARD_TEST_REAL: 'all' } }), real);
  assert.equal(selectBoundaryAdapter('board-api', { fake, real, env: {}, mode: 'real' }), real);
  assert.equal(selectBoundaryAdapter('board-api', { fake, real, env: { PULLBOARD_TEST_REAL: 'all' }, mode: 'fake' }), fake);
});

test('kernel.audit.scheduled-audit-forces-both-real: #9856 clause 3: the scheduled audit forces both boundaries real, even when a test asks for a fake [C7]', () => {
  const env = auditAdapterEnvironment(true);
  for (const boundary of NETWORK_BOUNDARIES) {
    assert.equal(selectBoundaryAdapter(boundary, { fake, real, env }), real);
    assert.equal(selectBoundaryAdapter(boundary, { fake, real, env, mode: 'fake' }), real);
  }
  for (const boundary of NETWORK_BOUNDARIES) assert.equal(selectBoundaryAdapter(boundary, { fake, real, env: auditAdapterEnvironment(false) }), fake);
});
