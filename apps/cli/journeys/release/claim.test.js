/** A successful native release clears its acknowledged claim immediately [B4,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

test('clause 1 and clause 2: a successful INELIGIBLE release immediately shows the item open and unheld [B4,C7]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const sandbox = helpers.sandbox();
  sandbox.env.PULLBOARD_MODEL = 'Release clears claim fixture';
  const box = helpers.project('true', sandbox);
  const added = fixtureAdd(box.run, box.repo, 'web', 'Release clears its claim', '--specs', 'G1',
    '--criterion', 'A successful release clears the claimed state [test].', '--check', 'true', '--route', 'strong', '--json');
  assert.equal(added.code, 0, added.err || added.out);
  const id = JSON.parse(added.out).item.item_id;
  const claimed = box.run(box.web, 'claim', String(id), '--json');
  assert.equal(claimed.code, 0, claimed.err || claimed.out);
  assert.equal(JSON.parse(claimed.out).id, id);
  const before = box.run(box.repo, 'show', String(id), '--json');
  assert.equal(before.code, 0, before.err || before.out);
  assert.equal(JSON.parse(before.out).item_status, 'claimed', 'the release starts with a real live claim');

  // Exercise the ordinary command exactly as a seat uses it, without suppressing its default continuation.
  const released = box.run(box.web, 'release', String(id), '--reason', 'INELIGIBLE');
  assert.equal(released.code, 0, released.err || released.out);
  assert.match(released.out, new RegExp(`released #${id}\\b`, 'u'));

  const shown = box.run(box.repo, 'show', String(id), '--json');
  assert.equal(shown.code, 0, shown.err || shown.out);
  const item = JSON.parse(shown.out);
  assert.equal(item.item_status, 'open', 'successful release remains open after its default continuation');
  assert.equal(item.item_owner, null, 'the releasing seat has no remaining claim');
  assert.equal(item.item_lease_until, null, 'the released claim retains no lease');
});
