/** @pullboard-test-input source-cell sandbox */
/** The sandbox smoke names its item and kind at the gate slot, so gate.requireRunnerAttribution can turn on safely [C7,#3849]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const SOURCE = join(import.meta.dirname, '../../src/io/smoke.js');

test('sandbox.attribution.smoke-slot-builder-test: clause 1: the sandbox smoke gate slot passes an item and kind builder-test [C7]', () => {
  const text = readFileSync(SOURCE, 'utf8');
  const at = text.indexOf('await withGateSlot(root');
  assert.notEqual(at, -1, 'smoke.js calls withGateSlot');
  const call = text.slice(at, at + 400);
  assert.match(call, /item: '[^']+'/u);
  assert.match(call, /kind: 'builder-test'/u);
});
