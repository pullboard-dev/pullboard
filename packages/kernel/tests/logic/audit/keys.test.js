/** The keys and GitHub/npm boundaries select a real or fake adapter per run and per test, and the audit forces both real [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  KEY_BOUNDARIES,
  auditAdapterEnvironment,
  selectBoundaryAdapter,
} from '../../../src/logic/audit.js';

const real = Object.freeze({ name: 'real' });
const fake = Object.freeze({ name: 'fake' });
const trapped = new Proxy({}, { get() { throw new Error('the fake selection read the real adapter'); } });

test('kernel.audit.keys-boundary-selects-real-or-fake: #9852 clause 1: the keys boundary selects real or fake per run and per test, and the fake never reads the real adapter [C7]', () => {
  assert.ok(KEY_BOUNDARIES.includes('keys'));
  assert.equal(selectBoundaryAdapter('keys', { fake, real, env: {} }), fake);
  assert.equal(selectBoundaryAdapter('keys', { fake, real, env: { PULLBOARD_TEST_REAL: 'keys' } }), real);
  assert.equal(selectBoundaryAdapter('keys', { fake, real, env: { PULLBOARD_TEST_REAL: 'git, keys' } }), real);
  assert.equal(selectBoundaryAdapter('keys', { fake, real, env: { PULLBOARD_TEST_REAL: 'all' } }), real);
  assert.equal(selectBoundaryAdapter('keys', { fake, real, env: {}, mode: 'real' }), real);
  assert.equal(selectBoundaryAdapter('keys', { fake, real, env: { PULLBOARD_TEST_REAL: 'all' }, mode: 'fake' }), fake);
  assert.equal(selectBoundaryAdapter('keys', { fake, real: trapped, env: {} }), fake, 'the fake selection never touches the real adapter');
});

test('kernel.audit.github-npm-boundary-selects-real-or-fake: #9852 clause 2: the GitHub/npm boundary selects real or fake the same way, and neither name selects the other [C7]', () => {
  assert.ok(KEY_BOUNDARIES.includes('github-npm'));
  assert.equal(selectBoundaryAdapter('github-npm', { fake, real, env: {} }), fake);
  assert.equal(selectBoundaryAdapter('github-npm', { fake, real, env: { PULLBOARD_TEST_REAL: 'github-npm' } }), real);
  assert.equal(selectBoundaryAdapter('github-npm', { fake, real, env: { PULLBOARD_TEST_REAL: 'all' } }), real);
  assert.equal(selectBoundaryAdapter('github-npm', { fake, real, env: {}, mode: 'real' }), real);
  assert.equal(selectBoundaryAdapter('github-npm', { fake, real, env: { PULLBOARD_TEST_REAL: 'all' }, mode: 'fake' }), fake);
  assert.equal(selectBoundaryAdapter('github-npm', { fake, real, env: { PULLBOARD_TEST_REAL: 'keys' } }), fake, 'keys never selects the github-npm real adapter');
  assert.equal(selectBoundaryAdapter('keys', { fake, real, env: { PULLBOARD_TEST_REAL: 'github-npm' } }), fake, 'github-npm never selects the keys real adapter');
});

test('kernel.audit.scheduled-audit-forces-keys-and-github-npm-real: #9852 clause 3: the scheduled audit forces both names real even with mode fake, and clock stays unregistered [C7]', () => {
  const env = auditAdapterEnvironment(true);
  for (const boundary of KEY_BOUNDARIES) {
    assert.equal(selectBoundaryAdapter(boundary, { fake, real, env }), real);
    assert.equal(selectBoundaryAdapter(boundary, { fake, real, env, mode: 'fake' }), real);
    assert.equal(selectBoundaryAdapter(boundary, { fake, real, env: auditAdapterEnvironment(false) }), fake);
  }
  assert.throws(() => selectBoundaryAdapter('clock', { fake, real, env }), TypeError);
});
