/** @pullboard-test-input source-cell apps/cli */
/** init records affectedTests for a single-language repo and never overwrites a set value [C7,#11016]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { affectedDefault } from '../../../src/logic/init/affected-default.js';
import { withAffectedDefault } from '../../../src/logic/init/affected-default.js';

test('cli.logic-init-affected-default.single-node-language: clause 1: affectedDefault returns node --test with selectionUnit file for exactly one detected node language [C7,#11016]', () => {
  assert.deepEqual(affectedDefault([{ language: 'node' }]), { affectedTests: 'node --test', selectionUnit: 'file' });
  assert.deepEqual(affectedDefault([{ language: 'node' }, { language: 'node' }]), { affectedTests: 'node --test', selectionUnit: 'file' }, 'one language listed twice is one language');
});

test('cli.logic-init-affected-default.no-default-otherwise: clause 1: affectedDefault returns null for two languages, a language with no affected row and an empty list [C7,#11016]', () => {
  assert.equal(affectedDefault([{ language: 'node' }, { language: 'python' }]), null);
  assert.equal(affectedDefault([{ language: 'make' }]), null);
  assert.equal(affectedDefault([{ language: 'cobol' }]), null);
  assert.equal(affectedDefault([]), null);
});

test('cli.logic-init-affected-default.keeps-a-set-value: clause 2: the default fills an absent affectedTests and never overwrites a set one [C7,#11016]', () => {
  assert.deepEqual(withAffectedDefault({ gate: 'npm test' }, [{ language: 'node' }]), { gate: 'npm test', affectedTests: 'node --test' });
  const set = { gate: 'npm test', affectedTests: 'vitest run' };
  assert.equal(withAffectedDefault(set, [{ language: 'node' }]), set);
  assert.deepEqual(withAffectedDefault({ gate: 'make' }, [{ language: 'make' }]), { gate: 'make' });
});

test('cli.logic-init-affected-default.other-runner-leaves-unset: clause 1: a test script naming jest, vitest or mocha leaves affectedTests unset and node --test keeps the default [C7,#11747]', () => {
  for (const test of ['jest', 'vitest run', 'mocha']) {
    const config = { gate: 'npm test' };
    assert.equal(withAffectedDefault(config, [{ language: 'node' }], { scripts: { test } }), config, test);
  }
  assert.deepEqual(withAffectedDefault({ gate: 'npm test' }, [{ language: 'node' }], { scripts: { test: 'node --test' } }), { gate: 'npm test', affectedTests: 'node --test' });
});

test('cli.logic-init-affected-default.other-runner-keeps-set-value: clause 2: a set affectedTests is never overwritten when the package names jest [C7,#11747]', () => {
  const set = { gate: 'npm test', affectedTests: 'vitest run' };
  assert.equal(withAffectedDefault(set, [{ language: 'node' }], { scripts: { test: 'jest' } }), set);
});
