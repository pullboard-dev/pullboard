/** The pure mutation-score judge refuses a drop below the last measured share per kind and nothing else [C7,#8369]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MUTATION_SCORE_DROP } from '../src/logic/mutate/judge.js';
import { judgeScoreDrop } from '../src/logic/mutate/judge.js';

test('cli.mutate-judge.a-kind-whose-caught-share-fell-below: clause 1: a kind whose caught share fell below its earlier share returns MUTATION_SCORE_DROP [C7]', () => {
  const verdict = judgeScoreDrop([{ kind: 'cell unit', caught: 4, seeded: 5 }], [{ kind: 'cell unit', caught: 3, seeded: 5 }]);
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.problems, [{ code: MUTATION_SCORE_DROP, kind: 'cell unit', earlier: '4/5', now: '3/5' }]);
  const rescaled = judgeScoreDrop([{ kind: 'contract', caught: 1, seeded: 2 }], [{ kind: 'contract', caught: 4, seeded: 10 }]);
  assert.equal(rescaled.problems.length, 1, 'shares compare, not counts');
});

test('cli.mutate-judge.equal-or-higher-shares-for-every-kind: clause 2: equal or higher shares for every kind return no problem [C7]', () => {
  const earlier = [{ kind: 'cell unit', caught: 3, seeded: 5 }, { kind: 'contract', caught: 1, seeded: 5 }];
  const now = [{ kind: 'cell unit', caught: 6, seeded: 10 }, { kind: 'contract', caught: 2, seeded: 5 }];
  assert.deepEqual(judgeScoreDrop(earlier, now), { ok: true, problems: [] });
});

test('cli.mutate-judge.a-kind-with-no-earlier-measured-share: clause 3: a kind with no earlier measured share is never refused [C7]', () => {
  assert.deepEqual(judgeScoreDrop([], [{ kind: 'journey', caught: 0, seeded: 5 }]), { ok: true, problems: [] });
  assert.deepEqual(judgeScoreDrop(undefined, [{ kind: 'journey', caught: 0, seeded: 5 }]), { ok: true, problems: [] });
  assert.deepEqual(judgeScoreDrop([{ kind: 'cell unit', caught: 0, seeded: 0 }], [{ kind: 'cell unit', caught: 0, seeded: 4 }]), { ok: true, problems: [] });
});
