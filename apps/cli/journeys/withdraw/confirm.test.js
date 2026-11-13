/** withdraw.review makes a withdrawal wait for a second seat to confirm it; off, it closes at once [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import {
  fixtureAdd,
  fixturePolicy,
} from '../../tests/fixtures/testkit.js';

/** A project with two open items, the withdraw.review setting as given, and the web seat caught up with main. */
async function setup(t, review) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  if (review !== undefined) fixturePolicy(box, { withdraw: { review } });
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  for (const title of ['Census of stale claims', 'Landing drill for the lander']) {
    const added = await fixtureAdd(box.inProcess, box.repo, 'web', title, '--criterion', `${title} is recorded [test]`, '--check', 'true');
    assert.equal(added.code, 0, `${added.out}${added.err}`);
  }
  return box;
}

/** The item's status from `show --json`. */
async function status(box, id) {
  const shown = await box.inProcess(box.repo, 'show', String(id), '--json');
  return JSON.parse(shown.out).item_status;
}

test('clauses 1 and 2: with withdraw.review on, withdraw waits and only another seat confirms [C7]', async (t) => {
  const box = await setup(t, true);
  const asked = await box.inProcess(box.web, 'withdraw', '1', 'Not needed');
  assert.equal(asked.code, 0, `${asked.out}${asked.err}`);
  assert.equal(await status(box, 1), 'open', 'clause 1: the item stays open while the withdrawal is pending');
  assert.match(`${asked.out}${asked.err}`, /withdraw 1 --confirm/u);
  const same = await box.inProcess(box.web, 'withdraw', '1', '--confirm');
  assert.notEqual(same.code, 0);
  assert.match(`${same.out}${same.err}`, /WITHDRAW_SAME_SEAT/u);
  assert.equal(await status(box, 1), 'open');
  // The coordinator is the seat that may close an item, so it is the second seat that confirms.
  const other = await box.inProcess(box.repo, 'withdraw', '1', '--confirm');
  assert.equal(other.code, 0, `${other.out}${other.err}`);
  assert.equal(await status(box, 1), 'withdrawn', 'clause 2: the other seat closes it');
});

test('clause 3: with it off, the default, withdraw closes the item at once [C7]', async (t) => {
  const box = await setup(t);
  const done = await box.inProcess(box.repo, 'withdraw', '2', 'Not needed');
  assert.equal(done.code, 0, `${done.out}${done.err}`);
  assert.equal(await status(box, 2), 'withdrawn');
});
