/** A red submit records its paired measurement and no submission; split from main.test.js for the file time limit [C7,V4,H16]. */
/** @pullboard-test-input source-tree */
/** @pullboard-test-loads packages/sandbox/index.js */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flakyProject } from '../../../../packages/git/tests/fixtures/flakes.js';
import { targetRuns } from '../../../../packages/git/tests/fixtures/flakes.js';
import { assertReceipts } from '../../../../packages/git/tests/fixtures/flakes.js';
import { privateBuilder } from '../../../../packages/git/tests/fixtures/flakes.js';
import { commitCandidate } from '../../../../packages/git/tests/fixtures/flakes.js';
import { checkedItem } from '../../../../packages/git/tests/fixtures/flakes.js';

test('a red submit records diagnostics without submitting the item [C7,V4,H16]', async t => {
  const box = flakyProject(t);
  const id = checkedItem(box);
  const builder = privateBuilder(box);
  const claimed = await builder.call('claim', String(id));
  assert.equal(claimed.code, 0, JSON.stringify(claimed.document));
  commitCandidate(builder, 'chore: controlled submission candidate');
  const result = await builder.call('submit', String(id));
  assert.equal(result.code, 1);
  assert.equal((await box.call('show', String(id))).document.item_status, 'claimed');
  // Changed today with the submit/landing rerun change: a red submit runs the target four times, and its pair stays red beside a green pinned main.
  assert.equal(targetRuns(box), 4, 'a red submit runs the target four times');
  const report = (await box.call('flakes')).document;
  assert.equal(report.flakes.length, 0, 'a candidate whose pair stays red is no flake');
  const observation = report.regressions[0].observations[0];
  assert.equal(observation.kind, 'submit');
  assert.equal(observation.original.green, false);
  assert.equal(observation.paired.green, false);
  assert.equal(observation.mainReceipt.green, true);
  assertReceipts(box, observation);
});
