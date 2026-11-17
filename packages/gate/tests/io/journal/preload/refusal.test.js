/** A failed fixture child names its refusal even when it printed it on stdout and nothing on stderr [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runFixtureChild } from '../../../fixtures/child.js';

test('gate.io-journal-preload-refusal.a-failing-json-style-child-shows: clause 2: a failing --json style child shows its stdout refusal in the failure context [C7]', (t) => {
  t.mock.method(process.stderr, 'write', () => true);
  const refusal = JSON.stringify({ version: 1, error: { code: 'CROSS_OWNERSHIP', message: 'the bar names a path no lane owns' } });
  const result = runFixtureChild(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(refusal)}); process.exit(1);`], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.context, /CROSS_OWNERSHIP/u, 'the refusal code is in the context');
  assert.match(result.failure, /the bar names a path no lane owns/u, 'the failure text carries the refusal message');
});

test('gate.io-journal-preload-refusal.a-passing-child-adds-no-stdout: clause 2: a passing child adds no stdout to its context [C7]', () => {
  const result = runFixtureChild(process.execPath, ['-e', 'process.stdout.write("fine")'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.failure, null);
  assert.doesNotMatch(result.context, /stdout:/u);
});
