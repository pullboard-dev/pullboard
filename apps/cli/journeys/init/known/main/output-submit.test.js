/** Exact case guidance carries the real main receipt and the filed owner through submit, without changing verdicts [V4,B3,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cli,
  fixture,
  rows,
} from '../../../../tests/fixtures/affected.js';
import {
  FILE,
  notice,
} from '../../../../tests/fixtures/init/known-main-notice.js';

test('identical main case is structured in submit, naming the owner the first run filed [V4,B3,C7]', async t => {
  const box = fixture(t);
  const tested = cli(box, box.builder, 'test', FILE, '--compare-main');
  assert.equal(tested.status, 1, tested.stdout + tested.stderr);
  const submitted = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(submitted.status, 0, submitted.stdout + submitted.stderr);
  const submission = JSON.parse(submitted.stdout);
  assert.equal(submission.gate.green, false);
  assert.equal(submission.gate.mainFailures.length, 1);
  // The first run filed main's red, so the board now names its owner.
  const filed = rows(box, "SELECT item_id FROM item WHERE item_title LIKE 'Main red: %'");
  assert.equal(filed.length, 1, JSON.stringify(filed));
  notice(submission.gate.mainFailures[0], box, { owner: filed[0].item_id });
});
