/** @pullboard-test-input apps/cli/journeys/spec/e2e/gates.test.js apps/cli/journeys/spec/main.test.js apps/cli/journeys/spec/changes.test.js apps/cli/journeys/resume/presence/heartbeat.test.js */
/**
 * The parity check for journeys moved in-process (#8257, U149): the gate runs a sample of one converted journey's cases twice,
 * once with every CLI call a real process and once in-process, and fails on any difference in exit code, JSON result or
 * board state [C7].
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parityDifferences } from './fixtures/journey-parity.js';
import { runSample } from './fixtures/journey-parity.js';

/** The converted journeys, and the cases of each the sample runs both ways (#8257 gates, #8267 the rest). */
const SAMPLES = [
  { journey: 'apps/cli/journeys/spec/e2e/gates.test.js', cases: [
    'unsupported spec grammar keeps claim, refreeze, submit and verify refusals typed',
    'pullboard worktree makes a joined worktree for a lane in one command',
  ] },
  { journey: 'apps/cli/journeys/spec/main.test.js', cases: [
    'real spec check refuses future grammar in either configured file',
    'spec check names both locations when ids repeat within or across configured files',
  ] },
  { journey: 'apps/cli/journeys/spec/changes.test.js', cases: ['[S19] unchanged approved rows and draft-row wording remain committable'] },
  { journey: 'apps/cli/journeys/resume/presence/heartbeat.test.js', cases: [
    'status reads and explicit hooks heartbeat without a shared board write',
    'plain status counts large seat history and hides gone seats behind --all',
  ] },
];

test('clause 1: a sample of a converted journey gives the same exit codes, JSON results and board state in a real process and in-process [C7]', () => {
  const real = runSample(SAMPLES, 'process');
  const inprocess = runSample(SAMPLES, 'inprocess');
  assert.ok(real.length >= 15, `the sample made its CLI calls (${real.length})`);
  assert.ok(real.some(row => row.board?.items.length), 'the records carry board state');
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
