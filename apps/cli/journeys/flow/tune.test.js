/** @pullboard-test-input apps/cli/src/io/commands/flow.js apps/cli/tests/fixtures/e2e.js apps/cli/tests/fixtures/flow/tune-history.js packages/stats/index.js */
/** pullboard flow replay --tune over the replay bench: the tuned line beats the untuned one on a busy board and is no worse on a one-seat board [C7,#1099]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { busyHistory } from '../../tests/fixtures/flow/tune-history.js';
import { oneSeatHistory } from '../../tests/fixtures/flow/tune-history.js';
import { TUNE_POLICY } from '../../tests/fixtures/flow/tune-history.js';

const MINUTE = 60_000;
const STAGES = ['build', 'reviewWait', 'review', 'sendBackIdle', 'mergeWait'];
const e2e = createE2eHelpers();
after(e2e.cleanup);

/** Run the real command over a seeded history in a scratch project and return its parsed result. */
async function replayTune(history) {
  const box = e2e.project();
  writeFileSync(join(box.repo, 'history.json'), JSON.stringify(history));
  writeFileSync(join(box.repo, 'policy.json'), JSON.stringify(TUNE_POLICY));
  const ran = await box.runLocal(box.repo, 'flow', 'replay', '--tune', '--history', 'history.json', '--policy', 'policy.json', '--json');
  assert.equal(ran.code, 0, ran.err || ran.out);
  const text = await box.runLocal(box.repo, 'flow', 'replay', '--tune', '--history', 'history.json', '--policy', 'policy.json');
  assert.equal(text.code, 0, text.err || text.out);
  return { result: JSON.parse(ran.out), text: text.out };
}

/** The median minutes from claim to landing over a replay's items. */
function median(side) {
  const spans = side.replay.items.map(item => (Date.parse(item.landedAt) - Date.parse(item.claimAt)) / MINUTE).sort((a, b) => a - b);
  return spans.length % 2 ? spans[(spans.length - 1) / 2] : (spans[spans.length / 2 - 1] + spans[spans.length / 2]) / 2;
}

test('cli.journeys-flow-tune.busy-board-tuned-beats-untuned: clause 1: pullboard flow replay --tune on a seeded busy history prints a tuned run whose median claim to landed is lower than the untuned run [C7,#1099]', { timeout: 120_000 }, async () => {
  const { result, text } = await replayTune(busyHistory());
  assert.ok(result.changes.length > 0, 'the tuner changed a setting while the replay ran');
  assert.equal(result.tuned.replay.items.length, result.untuned.replay.items.length, 'both runs land the same items');
  assert.ok(median(result.tuned) < median(result.untuned), `tuned median ${median(result.tuned)} minutes is lower than untuned ${median(result.untuned)} minutes`);
  assert.match(text, /^untuned: predicted; 40 measured; median claim to landed 660 minutes$/mu);
  assert.match(text, /^tuned: predicted; 40 measured; median claim to landed 270 minutes$/mu, 'the command prints both runs');
});

test('cli.journeys-flow-tune.one-seat-no-stage-worse: clause 2: pullboard flow replay --tune on a seeded one-seat history leaves no stage median of the tuned run higher than the untuned run [C7,#1099]', { timeout: 120_000 }, async () => {
  const { result, text } = await replayTune(oneSeatHistory());
  for (const stage of STAGES) {
    const tuned = result.tuned.replay.stages[stage].medianMinutes, untuned = result.untuned.replay.stages[stage].medianMinutes;
    assert.ok(tuned <= untuned, `${stage}: tuned median ${tuned} is no higher than untuned ${untuned}`);
  }
  assert.ok(median(result.tuned) <= median(result.untuned), 'the whole claim to landed median is no worse either');
  assert.match(text, /^untuned: predicted; 30 measured;/mu);
  assert.match(text, /^tuned: predicted; 30 measured;/mu);
});
