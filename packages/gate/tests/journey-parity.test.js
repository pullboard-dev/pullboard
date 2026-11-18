/** @pullboard-test-input apps/cli/journeys/spec/e2e/gates.test.js */
/**
 * The parity check for journeys moved in-process (#8257, U149): the gate runs a sample of one converted journey's cases twice,
 * once with every CLI call a real process and once in-process, and fails on any difference in exit code, JSON result or
 * board state [C7].
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parityDifferences } from './fixtures/journey-parity.js';
import { sampleDifferences } from './fixtures/journey-parity.js';

/** The converted journey, and its one representative case, run both ways (each case runs twice, so one keeps the file inside its budget). Later batches sample in their own files (each case runs twice). */
const SAMPLES = [
  { journey: 'apps/cli/journeys/spec/e2e/gates.test.js', cases: [
    'decisions default up the chain, pass to the person, and return to the original asker',
  ] },
];

test('gate.journey-parity.sample-converted-journey-gives-same: clause 1: a sample of a converted journey gives the same exit codes, JSON results and board state in a real process and in-process [C7]', async () => {
  const differences = await sampleDifferences(SAMPLES);
  assert.deepEqual(differences, [], `the two runtimes disagree:\n${differences.join('\n')}`);
});

test('gate.journey-parity.parity-comparison-fails-any-difference: clause 1: the parity comparison fails on any difference in exit code, JSON result or board state [C7]', () => {
  const row = { args: ['claim', '1', '--json'], code: 1, json: { error: { code: 'A5_GRAMMAR_VERSION' } }, out: null, err: '', board: { items: [{ item_id: 1, item_status: 'open', item_lane: 'web' }], events: [] } };
  assert.deepEqual(parityDifferences([row], [structuredClone(row)]), [], 'equal records agree');
  assert.match(parityDifferences([row], [{ ...row, code: 0 }]).join('\n'), /code differs/u);
  assert.match(parityDifferences([row], [{ ...row, json: { error: { code: 'OTHER' } } }]).join('\n'), /json differs/u);
  assert.match(parityDifferences([row], [{ ...row, board: { items: [{ ...row.board.items[0], item_status: 'claimed' }], events: [] } }]).join('\n'), /board differs/u);
  assert.match(parityDifferences([row, row], [row]).join('\n'), /call count/u);
});
