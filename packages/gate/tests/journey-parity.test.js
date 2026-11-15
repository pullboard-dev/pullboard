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
/** The converted journeys, and the cases of each the sample runs both ways (#8265 adds fact/msg, fact/board/busy and fact/board/schema). */
const SAMPLES = [
  { journey: 'apps/cli/journeys/spec/e2e/gates.test.js', cases: [
    'unsupported spec grammar keeps claim, refreeze, submit and verify refusals typed',
    'pullboard worktree makes a joined worktree for a lane in one command',
  ] },
  { journey: 'apps/cli/journeys/fact/msg.test.js', cases: ['a fresh board accepts a first commit that cites its item'] },
  { journey: 'apps/cli/journeys/fact/board/busy.test.js', cases: [
    'native import observes committed and rolled-back write ownership without changing restored rows',
    'a standalone native attempt and nested rollback each observe only their actual outer write',
  ] },
  { journey: 'apps/cli/journeys/fact/board/schema.test.js', cases: ['a stamped pre-carry board upgrades on main open and completes a native merge-only submission'] },
];

/** Run one journey's sample in a child node --test in one mode and return each CLI call's record, in call order. */
function runSample(mode, { journey, cases }) {
  const dir = privateFixtureFiles('pullboard-journey-parity-').root;
  const record = join(dir, `${mode}.jsonl`);
  try {
    const pattern = cases.map(name => name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|');
    const run = runChildTests([journey], { cwd: REPOSITORY, args: [`--test-name-pattern=^(?:${pattern})`],
      env: { ...process.env, PULLBOARD_JOURNEY_MODE: mode, PULLBOARD_PARITY_RECORD: record } });
    assert.equal(run.status, 0, `the ${mode} run of the ${journey} sample passes:\n${run.stdout.slice(-3000)}\n${run.stderr.slice(-2000)}`);
    assert.equal(run.pass, cases.length, `every sampled case of ${journey} ran in the ${mode} run`);
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
  for (const sample of SAMPLES) {
    const real = runSample('process', sample);
    const inprocess = runSample('inprocess', sample);
    assert.ok(real.length >= 3, `${sample.journey} made its CLI calls (${real.length})`);
    assert.ok(real.some(row => row.board?.items.length), `${sample.journey} records carry board state`);
    const differences = parityDifferences(real, inprocess);
    assert.deepEqual(differences, [], `the two runtimes disagree on ${sample.journey}:\n${differences.join('\n')}`);
  }
});

test('clause 1: the parity comparison fails on any difference in exit code, JSON result or board state [C7]', () => {
  const row = { args: ['claim', '1', '--json'], code: 1, json: { error: { code: 'A5_GRAMMAR_VERSION' } }, out: null, err: '', board: { items: [{ item_id: 1, item_status: 'open', item_lane: 'web' }], events: [] } };
  assert.deepEqual(parityDifferences([row], [structuredClone(row)]), [], 'equal records agree');
  assert.match(parityDifferences([row], [{ ...row, code: 0 }]).join('\n'), /code differs/u);
  assert.match(parityDifferences([row], [{ ...row, json: { error: { code: 'OTHER' } } }]).join('\n'), /json differs/u);
  assert.match(parityDifferences([row], [{ ...row, board: { items: [{ ...row.board.items[0], item_status: 'claimed' }], events: [] } }]).join('\n'), /board differs/u);
  assert.match(parityDifferences([row, row], [row]).join('\n'), /call count/u);
});
