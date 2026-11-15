/** @pullboard-test-input apps/cli/journeys/spec/e2e/gates.test.js */
/**
 * The parity check for journeys moved in-process (#8257, U149): the gate runs a sample of one converted journey's cases twice,
 * once with every CLI call a real process and once in-process, and fails on any difference in exit code, JSON result or
 * board state [C7].
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { runChildTests } from './fixtures/child-tests.js';
import { privateFixtureFiles } from './fixtures/child.js';

const REPOSITORY = resolve(import.meta.dirname, '../../..');
/** The converted journey, and its one representative case, run both ways (each case runs twice, so one keeps the file in its budget). */
const JOURNEY = 'apps/cli/journeys/spec/e2e/gates.test.js';
const SAMPLE = [
  'decisions default up the chain, pass to the person, and return to the original asker',
];

/** Run the sample in a child node --test in one mode and return each CLI call's record, in call order. */
function runSample(mode) {
  const dir = privateFixtureFiles('pullboard-journey-parity-').root;
  const record = join(dir, `${mode}.jsonl`);
  try {
    const pattern = SAMPLE.map(name => name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|');
    const run = runChildTests([JOURNEY], { cwd: REPOSITORY, args: [`--test-name-pattern=^(?:${pattern})`],
      env: { ...process.env, PULLBOARD_JOURNEY_MODE: mode, PULLBOARD_PARITY_RECORD: record } });
    assert.equal(run.status, 0, `the ${mode} run of the sample passes:\n${run.stdout.slice(-3000)}\n${run.stderr.slice(-2000)}`);
    assert.equal(run.pass, SAMPLE.length, `every sampled case ran in the ${mode} run`);
    return readFileSync(record, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Every difference between two runs' records, named by call: exit code, JSON result, printed text and board state. */
function parityDifferences(real, inprocess) {
  const differences = [];
  if (real.length !== inprocess.length) differences.push(`call count: process ${real.length}, in-process ${inprocess.length}`);
  for (let at = 0; at < Math.min(real.length, inprocess.length); at++) {
    const call = real[at].args.join(' ');
    for (const field of ['args', 'code', 'json', 'out', 'err', 'board']) {
      const [a, b] = [JSON.stringify(real[at][field]), JSON.stringify(inprocess[at][field])];
      if (a !== b) differences.push(`call ${at + 1} (${call}): ${field} differs\n  process:    ${String(a).slice(0, 400)}\n  in-process: ${String(b).slice(0, 400)}`);
    }
  }
  return differences;
}

test('clause 1: a sample of a converted journey gives the same exit codes, JSON results and board state in a real process and in-process [C7]', () => {
  const real = runSample('process');
  const inprocess = runSample('inprocess');
  assert.ok(real.length >= 15, `the sample made its CLI calls (${real.length})`);
  assert.ok(real.some(row => row.board?.events.length), 'the records carry board state');
  const differences = parityDifferences(real, inprocess);
  assert.deepEqual(differences, [], `the two runtimes disagree:\n${differences.join('\n')}`);
});

test('clause 1: the parity comparison fails on any difference in exit code, JSON result or board state [C7]', () => {
  const row = { args: ['claim', '1', '--json'], code: 1, json: { error: { code: 'A5_GRAMMAR_VERSION' } }, out: null, err: '', board: { items: [{ item_id: 1, item_status: 'open', item_lane: 'web' }], events: [] } };
  assert.deepEqual(parityDifferences([row], [structuredClone(row)]), [], 'equal records agree');
  assert.match(parityDifferences([row], [{ ...row, code: 0 }]).join('\n'), /code differs/u);
  assert.match(parityDifferences([row], [{ ...row, json: { error: { code: 'OTHER' } } }]).join('\n'), /json differs/u);
  assert.match(parityDifferences([row], [{ ...row, board: { items: [{ ...row.board.items[0], item_status: 'claimed' }], events: [] } }]).join('\n'), /board differs/u);
  assert.match(parityDifferences([row, row], [row]).join('\n'), /call count/u);
});
