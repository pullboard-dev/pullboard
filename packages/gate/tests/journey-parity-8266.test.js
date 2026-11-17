/** @pullboard-test-input apps/cli/journeys/verify/trunk.test.js apps/cli/journeys/engine/merged.test.js apps/cli/journeys/gate/slot.test.js */
/**
 * The parity check for the second in-process batch (#8266, U149): one representative case of verify/trunk, engine/merged and
 * gate/slot runs with every CLI call a real process and in-process, and any difference in exit code, JSON result or board state fails [C7].
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parityDifferences } from './fixtures/journey-parity.js';
import { runSample } from './fixtures/journey-parity.js';
import { sampleDifferences } from './fixtures/journey-parity.js';

/** Memoised: the three clause tests read one pair of runs, so each case still runs only twice. */
let found;
/**
 * gate/slot is sampled by its pre-push case, whose CLI calls are fixed (settings); its other cases poll a gate or a pulled submit,
 * so their call counts follow timing, and its one board is empty, which sampleDifferences does not accept.
 */
const SLOT = { journey: 'apps/cli/journeys/gate/slot.test.js', cases: ['pre-push keeps its machine gate slot until the hook check finishes'] };
const differences = () => found ??= (async () => {
  const [others, real, inprocess] = await Promise.all([sampleDifferences(SAMPLES), runSample('process', SLOT), runSample('inprocess', SLOT)]);
  assert.ok(real.length >= 1, `${SLOT.journey} made its CLI calls (${real.length})`);
  return [...others, ...parityDifferences(real, inprocess).map(text => `${SLOT.journey}: ${text}`)];
})();

const SAMPLES = [
  { journey: 'apps/cli/journeys/verify/trunk.test.js', cases: ['[B34,P2] add --check reports an unavailable baseline for a detached coordinator'] },
  { journey: 'apps/cli/journeys/engine/merged.test.js', cases: ['[R3,R1] --note records an otherwise uncarried merge receipt'] },
];

/** The differences of one kind (a field name in each difference's text). */
const only = async field => (await differences()).filter(text => text.includes(`: ${field} differs`) || text.includes('call count'));

test('gate.parity-8266.trunk-merged-slot-samples-give: clause 1: the trunk, merged and slot samples give the same exit codes in a real process and in-process [C7]', async () => {
  const found = await only('code');
  assert.deepEqual(found, [], `the two runtimes disagree:\n${found.join('\n')}`);
});

test('gate.parity-8266.trunk-merged-slot-samples-give-2: clause 2: the trunk, merged and slot samples give the same JSON results in a real process and in-process [C7]', async () => {
  const found = await only('json');
  assert.deepEqual(found, [], `the two runtimes disagree:\n${found.join('\n')}`);
});

test('gate.parity-8266.trunk-merged-slot-samples-leave: clause 3: the trunk, merged and slot samples leave the same board state, and print the same text, in a real process and in-process [C7]', async () => {
  const found = [...await only('board'), ...await only('out'), ...await only('err'), ...await only('args')];
  assert.deepEqual(found, [], `the two runtimes disagree:\n${found.join('\n')}`);
});
