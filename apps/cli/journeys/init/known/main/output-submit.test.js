/** Exact case guidance carries the real main receipt and the filed owner through submit, without changing verdicts [V4,B3,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cli,
  fixture,
  rows,
  settledSubmit,
} from '../../../../tests/fixtures/affected.js';
import {
  FILE,
  NAME,
} from '../../../../tests/fixtures/init/known-main-notice.js';

test('identical main case is structured in submit, naming the owner the first run filed [V4,B3,C7]', async t => {
  const box = fixture(t);
  const tested = cli(box, box.builder, 'test', FILE, '--compare-main');
  assert.equal(tested.status, 1, tested.stdout + tested.stderr);
  // A pulled submit returns queued at once; the settled gate's recorded submit carries the known main failures (c77c8f38cf).
  const settled = await settledSubmit(t, box);
  assert.equal(settled.submission?.gateGreen, true, JSON.stringify(settled.gate));
  const known = settled.submission.submissionProof.knownMainFailures.failures;
  assert.equal(known.length, 1, JSON.stringify(known));
  // The first run filed main's red, so the board now names its owner.
  const filed = rows(box, "SELECT item_id FROM item WHERE item_title LIKE 'Main red: %'");
  assert.equal(filed.length, 1, JSON.stringify(filed));
  assert.equal(known[0].item, filed[0].item_id);
  assert.equal(known[0].name, NAME);
  assert.equal(known[0].file, FILE);
});
