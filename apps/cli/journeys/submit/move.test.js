/** A pulled submit survives an unrelated main move while its gate runs and is accepted for landing [V4,H16,C7]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';
import { fixture } from '../../tests/fixtures/submit/move.js';
import { item } from '../../tests/fixtures/submit/move.js';

test('pulled submit lands green when unrelated main moves during its gate [V4,H16,C7]', async t => {
  const { box, main, settled, output } = await fixture(t, 'unrelated');
  assert.notEqual(box.git(box.repo, 'rev-parse', 'HEAD'), main, 'main moved while the gate ran');
  assert.doesNotMatch(output, /accepted main changed|NO_POLICY/u);
  assert.equal(settled.gate.green, true, output);
  assert.equal(item(box).item_status, 'submitted', output);
});

test('pulled submit with the queued policy survives an unrelated main move and is accepted for landing [V4,H16,C7]', async t => {
  const { box, settled, output } = await fixture(t, 'unrelated', true);
  assert.equal(settled.gate.green, true, output);
  const completed = item(box);
  assert.equal(completed.item_status, 'submitted', JSON.stringify(completed));
  // A second fixture seat reviews the submitted commit; its accept is the landing-ready verdict.
  const reviewer = join(box.dir, 'reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, completed.item_commit);
  assert.equal((await fixtureJoin(box.runLocal, reviewer, 'api')).code, 0);
  const accepted = await box.runLocal(reviewer, 'verify', String(box.id), 'accept', '--note', 'Ran the frozen check at the queued submission.', '--no-next');
  assert.equal(accepted.code, 0, accepted.out + accepted.err);
  const landed = item(box);
  assert.ok(landed.item_verdict === 'ACCEPT' || ['accepted', 'merged'].includes(landed.item_status), JSON.stringify(landed));
});

