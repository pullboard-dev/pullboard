/** The tour names its three slowest steps with their times, a slowed git commit among them [N10]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slowestSteps } from '../../src/logic/tour-steps.js';
import { typed } from '../../src/logic/tour-steps.js';

test('clause 1: a slow tour names its slowest steps, the slowed commit with its time [N10]', () => {
  const commit = `git ${typed(['commit', '-q', '-m', 'feat(app): greet by name [G1]'])}`;
  const line = slowestSteps([
    { label: 'pullboard next', ms: 40.4 },
    { label: commit, ms: 15_234.6 },
    { label: 'pullboard submit 1', ms: 900 },
    { label: 'pullboard log', ms: 12 },
  ]);
  assert.match(line, /^slowest steps: git commit -q -m "feat\(app\)[^;]*? 15235 ms; pullboard submit 1 900 ms; pullboard next 40 ms$/u);
  assert.match(line, /git commit -q -m "feat\(app\)[^;]*? ([0-9]{5,}) ms/u, 'the slowed commit is named with its time');
  assert.doesNotMatch(line, /pullboard log/u, 'only the three slowest are named');
});

test('clause 2: arguments with spaces or shell characters are quoted as a person would type them [N10]', () => {
  assert.equal(typed(['verify', '1', 'reject']), 'verify 1 reject');
  assert.equal(typed(['-m', 'a b', "it's", '$HOME']), '-m "a b" "it\'s" "$HOME"');
});
