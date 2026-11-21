/** @pullboard-test-input source-cell packages/kernel */
/** The fs, process and git remote boundaries register in the adapter switch beside the clock and env ones [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CLOCK_ENV_BOUNDARIES,
  FS_PROCESS_GIT_BOUNDARIES,
  KEY_BOUNDARIES,
  NETWORK_BOUNDARIES,
  auditAdapterEnvironment,
  selectBoundaryAdapter,
} from '../../../src/logic/audit.js';

const real = Object.freeze({ name: 'real' });
const fake = Object.freeze({ name: 'fake' });
const trapped = new Proxy({}, { get() { throw new Error('the fake selection read the real adapter'); } });

/** A tiny in-memory tree standing in for the fake fs adapter. */
function memoryFs() {
  const tree = new Map();
  return { name: 'fake', writeFile: (path, text) => tree.set(path, text), readFile: (path) => tree.get(path), exists: (path) => tree.has(path) };
}

test('kernel.audit.fs-boundary-selects-real-or-fake: #9851 clause 1: the fs boundary selects real or fake per run and per test, the fake using an in-memory tree [C7]', () => {
  assert.deepEqual(FS_PROCESS_GIT_BOUNDARIES, ['fs', 'process', 'git-remote']);
  const memory = memoryFs();
  const realFs = Object.freeze({ name: 'real' });
  const chosen = selectBoundaryAdapter('fs', { fake: memory, real: realFs, env: {} });
  assert.equal(chosen, memory);
  chosen.writeFile('/a/b.txt', 'hello');
  assert.equal(chosen.readFile('/a/b.txt'), 'hello');
  assert.equal(chosen.exists('/missing'), false);
  assert.equal(selectBoundaryAdapter('fs', { fake: memory, real: realFs, env: { PULLBOARD_TEST_REAL: 'fs' } }), realFs);
  assert.equal(selectBoundaryAdapter('fs', { fake: memory, real: realFs, env: { PULLBOARD_TEST_REAL: 'git, fs' } }), realFs);
  assert.equal(selectBoundaryAdapter('fs', { fake: memory, real: realFs, env: {}, mode: 'real' }), realFs);
  assert.equal(selectBoundaryAdapter('fs', { fake: memory, real: realFs, env: { PULLBOARD_TEST_REAL: 'all' }, mode: 'fake' }), memory);
  assert.equal(selectBoundaryAdapter('fs', { fake: memory, real: trapped, env: {} }), memory, 'the fake selection never touches the real adapter');
  for (const boundary of [...NETWORK_BOUNDARIES, ...KEY_BOUNDARIES, ...CLOCK_ENV_BOUNDARIES]) assert.equal(selectBoundaryAdapter(boundary, { fake, real, env: {} }), fake);
});

test('kernel.audit.process-git-remote-boundaries-select-real-or-fake: #9851 clause 2: the process and git remote boundaries select real or fake the same way [C7]', () => {
  for (const boundary of ['process', 'git-remote']) {
    assert.equal(selectBoundaryAdapter(boundary, { fake, real, env: {} }), fake);
    assert.equal(selectBoundaryAdapter(boundary, { fake, real, env: { PULLBOARD_TEST_REAL: boundary } }), real);
    assert.equal(selectBoundaryAdapter(boundary, { fake, real, env: { PULLBOARD_TEST_REAL: 'fs' } }), fake);
    assert.equal(selectBoundaryAdapter(boundary, { fake, real, env: {}, mode: 'real' }), real);
    assert.equal(selectBoundaryAdapter(boundary, { fake, real, env: { PULLBOARD_TEST_REAL: 'all' }, mode: 'fake' }), fake);
    assert.equal(selectBoundaryAdapter(boundary, { fake, real: trapped, env: {} }), fake);
  }
});

test('kernel.audit.scheduled-audit-forces-fs-process-git-remote-real: #9851 clause 3: the scheduled audit forces all three real even with mode fake [C7]', () => {
  const audit = auditAdapterEnvironment(true);
  for (const boundary of FS_PROCESS_GIT_BOUNDARIES) {
    assert.equal(selectBoundaryAdapter(boundary, { fake, real, env: audit }), real);
    assert.equal(selectBoundaryAdapter(boundary, { fake, real, env: audit, mode: 'fake' }), real);
    assert.equal(selectBoundaryAdapter(boundary, { fake, real, env: auditAdapterEnvironment(false) }), fake);
  }
  assert.throws(() => selectBoundaryAdapter('unregistered', { fake, real, env: audit }), TypeError);
});
