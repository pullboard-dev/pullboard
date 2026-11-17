/** @pullboard-test-input source-cell apps/cli */
/** The CLI gate-slot callers for verify, check and doctrine name their item and kind, so gate.requireRunnerAttribution never refuses them [C7,#4000]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const COMMANDS = join(import.meta.dirname, '../../src/io/commands');

/** The text of every `withGateSlot(` call's tail in one command file, up to the next call or the file's end. */
function slotCalls(file) {
  const parts = readFileSync(join(COMMANDS, file), 'utf8').split(/(?<![\w.])await withGateSlot\(|return withGateSlot\(|= withGateSlot\(/u).slice(1);
  assert.ok(parts.length > 0, `${file} calls withGateSlot`);
  return parts;
}

/** The options each call passes, found by their kind key. */
function optionsOf(file, kind) {
  const call = slotCalls(file).find(part => part.includes(`kind: '${kind}'`));
  assert.ok(call, `${file} passes kind '${kind}' to its gate slot`);
  return call.slice(call.indexOf(`kind: '${kind}'`) - 160, call.indexOf(`kind: '${kind}'`) + 80);
}

test('clause 1: verify names the item and kind review on its gate slot [C7]', () => {
  assert.match(optionsOf('verify.js', 'review'), /item: String\(id\), kind: 'review'/u);
});

test('clause 1: check names the item and its kind on its gate slot [C7]', () => {
  assert.match(optionsOf('check.js', 'check'), /item: String\(item\.item_id\), kind: 'check'/u);
});

test('clause 1: doctrine check names an item and its kind on its gate slot [C7]', () => {
  assert.match(optionsOf('doctrine.js', 'doctrine'), /kind: 'doctrine', item: '[^']+'/u);
});
