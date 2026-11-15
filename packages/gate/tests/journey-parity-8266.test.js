/** @pullboard-test-input apps/cli/journeys/verify/trunk.test.js apps/cli/journeys/engine/merged.test.js apps/cli/journeys/gate/slot.test.js */
/**
 * The parity check for the second in-process batch (#8266, U149): one representative case of verify/trunk, engine/merged and
 * gate/slot runs with every CLI call a real process and in-process, and any difference in exit code, JSON result or board state fails [C7].
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleDifferences } from './fixtures/journey-parity.js';

/** Memoised: the three clause tests read one pair of runs, so each case still runs only twice. */
let found;
const differences = () => found ??= sampleDifferences(SAMPLES);

const SAMPLES = [
  { journey: 'apps/cli/journeys/verify/trunk.test.js', cases: ['[B34,P2] add --check reports an unavailable baseline for a detached coordinator'] },
  { journey: 'apps/cli/journeys/engine/merged.test.js', cases: ['[R3,R1] --note records an otherwise uncarried merge receipt'] },
  { journey: 'apps/cli/journeys/gate/slot.test.js', cases: ['submit needs a clean tree, nothing untracked, and the gate green at HEAD'] },
];

/** The differences of one kind (a field name in each difference's text). */
const only = async field => (await differences()).filter(text => text.includes(`: ${field} differs`) || text.includes('call count'));

test('clause 1: the trunk, merged and slot samples give the same exit codes in a real process and in-process [C7]', async () => {
  const found = await only('code');
  assert.deepEqual(found, [], `the two runtimes disagree:\n${found.join('\n')}`);
});

test('clause 2: the trunk, merged and slot samples give the same JSON results in a real process and in-process [C7]', async () => {
  const found = await only('json');
  assert.deepEqual(found, [], `the two runtimes disagree:\n${found.join('\n')}`);
});

test('clause 3: the trunk, merged and slot samples leave the same board state, and print the same text, in a real process and in-process [C7]', async () => {
  const found = [...await only('board'), ...await only('out'), ...await only('err'), ...await only('args')];
  assert.deepEqual(found, [], `the two runtimes disagree:\n${found.join('\n')}`);
});
