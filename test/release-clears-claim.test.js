import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';

test('a successful INELIGIBLE release immediately shows the claim open and unheld [B4]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const added = box.run(box.repo, 'add', 'web', 'Release clears its claim', '--specs', 'G1',
    '--criterion', 'A successful release clears this claim.', '--check', 'true',
    '--brief', 'Files: web/release.js\nTest: release immediately clears the claimed state');
  assert.equal(added.code, 0, added.err + added.out);
  const id = JSON.parse(added.out).item.item_id;
  const claimed = box.run(box.web, 'claim', String(id));
  assert.equal(claimed.code, 0, claimed.err + claimed.out);

  const released = box.run(box.web, 'release', String(id), '--reason', 'INELIGIBLE');
  assert.equal(released.code, 0, released.err + released.out);
  assert.match(released.out, new RegExp(`released #${id}`, 'u'));

  const shown = box.run(box.repo, 'show', String(id), '--json');
  assert.equal(shown.code, 0, shown.err + shown.out);
  const item = JSON.parse(shown.out);
  assert.equal(item.item_status, 'open');
  assert.equal(item.item_owner, null);
});
