/** @pullboard-test-input source-cell rigor */
/** The rigor proof names its item and kind at the gate slot, so gate.requireRunnerAttribution can turn on safely [C7,#3849]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const SOURCE = join(import.meta.dirname, '../../src/io/proof.js');

test('rigor.attribution.proof-slot-flake-diagnose: clause 1: the rigor proof gate slot passes its item and kind flake-diagnose [C7]', () => {
  const text = readFileSync(SOURCE, 'utf8');
  const at = text.indexOf('.withGateSlot(root');
  assert.notEqual(at, -1, 'proof.js calls withGateSlot');
  const call = text.slice(at, at + 700);
  assert.match(call, /item: cause\.key/u);
  assert.match(call, /kind: 'flake-diagnose'/u);
  assert.doesNotMatch(call, /rigor-proof/u);
});
