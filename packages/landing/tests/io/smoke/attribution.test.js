/** @pullboard-test-input source-cell landing */
/** Every landing slot that can reach a runner names its item and kind, so gate.requireRunnerAttribution can turn on safely [C7,#4000]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const SOURCE = join(import.meta.dirname, '../../../src/io');

/** The options object of the first call to `name` in a landing source file. */
function optionsOf(file, name) {
  const text = readFileSync(join(SOURCE, file), 'utf8');
  const at = text.indexOf(`${name}(`);
  assert.notEqual(at, -1, `${file} calls ${name}`);
  return text.slice(at, at + 700);
}

test('landing.attribution.the-landing-smoke-names-its-item: clause 2: the landing smoke names its item and kind [C7]', () => {
  const call = optionsOf('smoke.js', 'await runCheckOnRunner');
  assert.match(call, /kind: 'landing-smoke'/u);
  assert.match(call, /item: '[^']+'/u);
});

test('landing.attribution.the-runner-only-check-slot-passes: clause 2: the runner-only check slot passes its item and kind to the gate slot [C7]', () => {
  const slot = readFileSync(join(SOURCE, 'main/red.js'), 'utf8').split('export async function runCheckOnRunner')[1];
  assert.match(slot, /diagnostic: true, kind, item,/u);
});

test('landing.attribution.the-deferred-affected-run-the-landing: clause 2: the deferred affected run, the landing diagnostic and the main comparison name their item and kind [C7]', () => {
  assert.match(readFileSync(join(SOURCE, 'deferred/run.js'), 'utf8'), /kind: 'gate', item: '[^']+'/u);
  assert.match(readFileSync(join(SOURCE, 'step/diagnose.js'), 'utf8'), /kind: 'land-diagnostic', item: '[^']+'/u);
  assert.match(readFileSync(join(SOURCE, 'main/red.js'), 'utf8'), /kind: 'main-red', item: '[^']+'/u);
});
