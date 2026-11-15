/** @pullboard-test-input apps/cli/journeys/verify/trunk.test.js apps/cli/journeys/engine/merged.test.js apps/cli/journeys/gate/slot.test.js */
/**
 * The parity check for the second in-process batch (#8266, U149): one representative case of verify/trunk, engine/merged and
 * gate/slot runs with every CLI call a real process and in-process, and any difference in exit code, JSON result or board state fails [C7].
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parityDifferences } from './fixtures/journey-parity.js';
import { runSample } from './fixtures/journey-parity.js';

const SAMPLES = [
  { journey: 'apps/cli/journeys/verify/trunk.test.js', cases: ['[B34,P2] add --check reports an unavailable baseline for a detached coordinator'] },
  { journey: 'apps/cli/journeys/engine/merged.test.js', cases: ['[R3,R1] --note records an otherwise uncarried merge receipt'] },
  { journey: 'apps/cli/journeys/gate/slot.test.js', cases: ['submit needs a clean tree, nothing untracked, and the gate green at HEAD'] },
];

test('clause 1: a sample of trunk, merged and slot gives the same exit codes, JSON results and board state in a real process and in-process [C7]', () => {
  const real = runSample('process', SAMPLES);
  const inprocess = runSample('inprocess', SAMPLES);
  assert.ok(real.length >= 5, `the sample made its CLI calls (${real.length})`);
  const differences = parityDifferences(real, inprocess);
  assert.deepEqual(differences, [], `the two runtimes disagree:\n${differences.join('\n')}`);
});
