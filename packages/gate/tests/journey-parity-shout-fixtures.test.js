/** @pullboard-test-input apps/cli/journeys/shout/journeys/fixture-setup.test.js apps/cli/journeys/shout/journeys/fixture-presentation.test.js */
/** @pullboard-world-pin: clause 2 reads the two journey sources to count their cases. */
/**
 * The parity check for the shout fixture journeys converted in #10152 (U149): one case each of fixture-setup and fixture-presentation runs
 * twice, once with every journey CLI call a real process and once in-process, and the exit codes, JSON results and board state must agree.
 * Both journeys share one file because they share one fixture family; each keeps its own sampled case [C7].
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { sampleDifferences } from './fixtures/journey-parity.js';

const SAMPLES = [
  { journey: 'apps/cli/journeys/shout/journeys/fixture-setup.test.js', total: 2, cases: ['the cockpit fixture inits its board without a model [N26]'] },
  { journey: 'apps/cli/journeys/shout/journeys/fixture-presentation.test.js', total: 3,
    cases: ['clause 1: borrowed board presentation keeps parity, shows staged rows, and leaves the caller connection open [N26,H16]'] },
];

test('gate.parity-shout-fixtures.sample-fixture-setup-and-presentation-give: clause 1: a sample of the fixture-setup and fixture-presentation shout journeys gives the same exit codes, JSON results and board state in a real process and in-process [C7]', async () => {
  const differences = await sampleDifferences(SAMPLES.map(({ journey, cases }) => ({ journey, cases })));
  assert.deepEqual(differences, [], `the two runtimes disagree:\n${differences.join('\n')}`);
});

test('gate.parity-shout-fixtures.fixture-journeys-keep-all-cases: clause 2: fixture-setup keeps all 2 of its cases and fixture-presentation all 3, and each sampled case is one of them [C7]', () => {
  for (const sample of SAMPLES) {
    const source = readFileSync(new URL(`../../../${sample.journey}`, import.meta.url), 'utf8');
    const cases = [...source.matchAll(/^test\((["'`])(.*?)\1/gmu)].map(match => match[2]);
    assert.equal(cases.length, sample.total, `${sample.journey} keeps its ${sample.total} cases, found ${cases.length}`);
    for (const name of sample.cases) assert.ok(cases.includes(name), `${sample.journey} still has the sampled case "${name}"`);
  }
});
