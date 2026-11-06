import test from 'node:test';
import assert from 'node:assert/strict';
import { gateWaitReporter } from '../src/gate-wait.js';

// A run that inherits its parent's gate slot (a frozen check calling pullboard test inside submit)
// is admitted at once and reports no holders; it must not crash the submit.
test('an admitted run that inherited the gate slot says nothing and does not throw', () => {
  const said = [];
  const report = gateWaitReporter({ say: (line) => said.push(line) });
  assert.doesNotThrow(() => report({ admitted: true }));
  assert.deepEqual(said, []);
});
