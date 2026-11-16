/** @pullboard-test-input source-cell landing */
/** The landing gate-slot callers name their item and kind so gate.requireRunnerAttribution never refuses them [C7,#4000]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const SOURCE = join(import.meta.dirname, '../../src/io');

/** Every withGateSlot call in a landing source file, from its name to the next call or the file's end. */
function slotCalls(file) {
  const parts = readFileSync(join(SOURCE, file), 'utf8').split(/(?<![\w.])withGateSlot\(/u).slice(1);
  assert.ok(parts.length > 0, `${file} calls withGateSlot`);
  return parts;
}

test('clause 1: the landing doctrine slot passes item and kind landing [C7]', () => {
  for (const call of slotCalls('doctrine.js')) {
    assert.match(call, /kind: 'landing', item: '[^']+'/u);
  }
});

test('clause 1: the main-red slots and the runner check slot pass an item and a kind [C7]', () => {
  const red = slotCalls('main/red.js');
  const named = red.filter(call => /slotOptions\(/u.test(call) || /diagnostic: true, kind, item,/u.test(call));
  assert.match(readFileSync(join(SOURCE, 'main/red.js'), 'utf8'), /const slotOptions = .*kind: 'main-red', item: 'main'/u);
  assert.equal(named.length, red.length, 'every withGateSlot call in main/red.js is attributed');
});
