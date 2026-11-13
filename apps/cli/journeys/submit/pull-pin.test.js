/** A pulled submit pins the item's commit as the controller path does, so doctor and review find it whatever the gate decides [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pullProject } from '../../tests/fixtures/pull.js';
import { submitOne } from '../../tests/fixtures/pull.js';

test('clause 1: a pulled submit writes the item pin ref while its gate job is queued, and doctor reports no missing pin [C7]', async t => {
  const box = await pullProject(t, 1);
  const [id] = box.ids;
  const { folder, commit, document } = submitOne(box, id);
  assert.equal(document.queued, true, 'the gate is queued, not run on this host');
  const pin = `refs/pullboard/items/${id}/${commit.slice(0, 12)}`;
  assert.equal(box.git(folder, 'rev-parse', '--verify', `${pin}^{commit}`), commit);
  assert.equal(box.git(box.repo, 'rev-parse', '--verify', `${pin}^{commit}`), commit, 'the board repository holds the same pin');
  const doctor = box.run(box.web, 'doctor', '--json');
  assert.doesNotMatch(`${doctor.out}${doctor.err}`, /ITEM_PIN_MISSING/u, 'doctor finds no missing pin');
});
