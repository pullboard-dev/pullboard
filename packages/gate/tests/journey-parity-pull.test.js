/** @pullboard-test-input apps/cli/tests/io/commands/gate/pipe.test.js apps/cli/tests/fixtures/pull.js */
/** @pullboard-world-pin: clause 2 reads the committed pull fixture source to prove its quick calls start no CLI process in-process. */
/**
 * The parity check for the pull fixture (U149): its add, claim and bar calls now run in-process (a warm worker thread for the sync
 * helpers), so a pull journey runs one sampled case twice, once with every journey CLI call a real process and once in-process, and the
 * exit codes, JSON results and board state must agree. Submit stays a real process, since it hands the gate job on [C7].
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { sampleDifferences } from './fixtures/journey-parity.js';

const SAMPLES = [{ journey: 'apps/cli/tests/io/commands/gate/pipe.test.js', cases: ['a pulled gate of a piped command settles red on the runner when an early stage fails [V16,C7]'] }];

test('gate.journey-parity-pull.a-pull-fixture-sample-gives-the-same: clause 1: a pull-fixture sample gives the same exit codes, JSON results and board state in a real process and in-process [C7]', async () => {
  const differences = await sampleDifferences(SAMPLES);
  assert.deepEqual(differences, [], `the two runtimes disagree:\n${differences.join('\n')}`);
});

test('gate.journey-parity-pull.the-pull-fixture-starts-no-cli-process: clause 2: the pull fixture starts no CLI process for its add, claim and bar calls when the journey runs in-process [C7]', () => {
  const source = readFileSync(new URL('../../../apps/cli/tests/fixtures/pull.js', import.meta.url), 'utf8');
  const quick = source.slice(source.indexOf('function quick('), source.indexOf('export function submitOne'));
  assert.match(quick, /JOURNEY_MODE === 'process' \? box\.run\(cwd, \.\.\.args\) : box\.runSync\(cwd, \.\.\.args\)/u, 'quick answers on the worker thread unless the journey runs as processes');
  assert.doesNotMatch(source, /box\.runAsync\(box\.web, 'claim'/u, 'no claim starts a real process');
  assert.doesNotMatch(source, /fixtureAdd\(box\.runAsync/u, 'no add starts a real process');
  assert.doesNotMatch(source, /box\.run\(box\.(web|repo), '(claim|bar)'/u, 'no claim or bar starts a real process');
});
