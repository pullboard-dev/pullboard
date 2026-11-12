/** add refuses a likely duplicate of an open item unless the filer says why it differs [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

const CRITERION = 'The nightly census job reports every stale seat claim with its holder and age [test]';

/** A project holding one open item. */
async function setup(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const isolated = helpers.sandbox();
  const box = helpers.project('true', isolated);
  const first = await fixtureAdd(box.inProcess, box.repo, 'web', 'Census reports stale seat claims', '--criterion', CRITERION, '--check', 'true');
  assert.equal(first.code, 0, `${first.out}${first.err}`);
  return box;
}

test('clause 1: add refuses DUPLICATE_LIKELY for a near copy of an open item and names it [C7]', async (t) => {
  const box = await setup(t);
  const again = await fixtureAdd(box.inProcess, box.repo, 'web', 'Census reports stale seat claims', '--criterion', CRITERION, '--check', 'true');
  assert.notEqual(again.code, 0);
  const text = `${again.out}${again.err}`;
  assert.match(text, /DUPLICATE_LIKELY/u);
  assert.match(text, /#1 "Census reports stale seat claims"/u);
});

test('clause 2: --not-duplicate-of with a reason files the item and records the reason [C7]', async (t) => {
  const box = await setup(t);
  const again = await fixtureAdd(box.inProcess, box.repo, 'web', 'Census reports stale seat claims', '--criterion', CRITERION, '--check', 'true',
    '--not-duplicate-of', '1 this one covers the private board only');
  assert.equal(again.code, 0, `${again.out}${again.err}`);
  const shown = await box.inProcess(box.repo, 'show', '2');
  assert.match(`${shown.out}${shown.err}`, /Not a duplicate of #1: this one covers the private board only/u);
});
