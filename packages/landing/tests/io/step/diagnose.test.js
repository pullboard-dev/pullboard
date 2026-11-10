/** An unclassified landing red is treated as real and goes to bisect, never blocking the batch [C7,#2914]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diagnose } from '../../../src/io/step/diagnose.js';

const STATE = { config: { flakes: { rerun: true } }, batch: { logPath: '/nowhere/local-trunk-4.log' }, diagnosed: new Map() };
const FAILURES = [{ file: 'test/a.test.js', name: 'a' }, { file: 'test/b.test.js', name: 'b' }];

test('unrecorded and unclassified observations count as real reds, so landing bisects instead of refusing [C7,#2914]', async () => {
  const gate = { logPath: STATE.batch.logPath, flakeDiagnostics: { observations: [
    { file: 'test/a.test.js', recorded: false, classification: 'unclassified' },
    { file: 'test/b.test.js', recorded: true, classification: 'unclassified' },
  ] } };
  assert.deepEqual(await diagnose(STATE, FAILURES, gate), [], 'no file is a flake, and nothing throws LAND_DIAGNOSTIC');
});

test('a classified flake is still returned as a flake [C7,#2914]', async () => {
  const gate = { logPath: STATE.batch.logPath, flakeDiagnostics: { observations: [
    { file: 'test/a.test.js', recorded: true, classification: 'flake' },
    { file: 'test/b.test.js', recorded: true, classification: 'unclassified' },
  ] } };
  assert.deepEqual(await diagnose(STATE, FAILURES, gate), ['test/a.test.js']);
});

test('a flake classification without a recorded observation is not trusted [C7,#2914]', async () => {
  const gate = { logPath: STATE.batch.logPath, flakeDiagnostics: { observations: [
    { file: 'test/a.test.js', classification: 'flake' },
  ] } };
  assert.deepEqual(await diagnose(STATE, FAILURES, gate), [], 'an observation with no recorded field is a real red, so it bisects');
});
