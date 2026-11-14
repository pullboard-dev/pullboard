/** @pullboard-test-input source-cell apps/cli apps/lib flakes git gate */
import { flakyProject } from '../../../../packages/git/tests/fixtures/flakes.js';
import { writeTarget } from '../../../../packages/git/tests/fixtures/flakes.js';
import { targetRuns } from '../../../../packages/git/tests/fixtures/flakes.js';
import { privateBuilder } from '../../../../packages/git/tests/fixtures/flakes.js';
import { settledCommit } from '../../../../packages/git/tests/fixtures/flakes.js';
import { checkedItem } from '../../../../packages/git/tests/fixtures/flakes.js';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
/** Native flake observations: a frozen private check that changes its source [C7,V4,H16]. */

test('a frozen private check that changes its source records no pair, and verify accepts on one run [C7,V4,H16]', async t => {
  const box = flakyProject(t, { alwaysPass: 'controlled' });
  const id = checkedItem(box);
  const builder = privateBuilder(box);
  assert.equal((await builder.call('claim', String(id))).code, 0);
  writeTarget(builder.root, box.counter, 'controlled', 'controlled');
  builder.git('add', '-A'); builder.git('commit', '-q', '-m', 'chore: controlled private-check mutation');
  const submitted = await builder.call('submit', String(id));
  assert.equal(submitted.code, 0, JSON.stringify(submitted.document));
  // The pulled gate posts its receipt before the item holds a submitted commit [P7,C7].
  const head = await settledCommit(box, id);
  writeFileSync(box.counter, ''); writeFileSync(box.counter + '.mode', 'paired');
  const reviewer = privateBuilder(box);
  reviewer.git('checkout', '-q', '--detach', head);
  const result = await reviewer.call('verify', String(id), 'accept');
  // Changed today: verify runs the check once and accepts (no CHECK_RED), so no diagnostic pair is made.
  assert.equal(result.code, 0, JSON.stringify(result.document));
  assert.equal(targetRuns(box), 1, 'verify runs the changed private check once, with no diagnostic pair');
  const report = (await box.call('flakes')).document;
  assert.equal(report.flakes.length, 0);
  assert.equal(report.unclassified.length, 0, 'no unchanged-source pair or observation is recorded');
});
