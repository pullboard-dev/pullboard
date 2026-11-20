/** pullboard next --stuck "<why>" releases the one held claim as BLOCKED through the release move and answers as next does [C7,#11700]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { cli } from '../../fixtures/next/take.js';
import { fixture } from '../../fixtures/next/take.js';

/** The release events an item recorded, with their detail parsed. */
const releases = (box, id) => box.board.db.prepare("SELECT event_detail d FROM event WHERE item_id=? AND event_kind='release'").all(id).map(row => JSON.parse(row.d));

test('cli.io-commands-next.stuck-releases-and-continues: clause 1: a seat holding one claim runs next --stuck "waits on the schema"; the item is open again with a BLOCKED release carrying that note, and the same call claims another item [C7,#11700]', async t => {
  const box = await fixture(t);
  const held = box.add('The item the seat is stuck on');
  const other = box.add('Another item for the same seat');
  const claimed = await cli(box, box.seats.actor.path, ['claim', String(held)]);
  assert.equal(claimed.code, 0, claimed.out + claimed.err);
  const ran = await cli(box, box.seats.actor.path, ['next', '--stuck', 'waits on the schema']);
  assert.equal(ran.code, 0, ran.out + ran.err);
  assert.equal(store.getItem(box.board, held).item_owner, null, 'the stuck item is free');
  const [release] = releases(box, held);
  assert.equal(release.reasonCode, 'BLOCKED');
  assert.equal(release.reason, 'waits on the schema');
  assert.equal(store.getItem(box.board, other).item_owner, box.seats.actor.id, 'the same call claimed another item');
});

test('cli.io-commands-next.stuck-needs-a-claim-and-a-reason: clause 2: next --stuck with no held claim, or with an empty reason, is refused USAGE naming pullboard next, and the board is unchanged [C7,#11700]', async t => {
  const box = await fixture(t);
  const held = box.add('A held item');
  const noClaim = await cli(box, box.seats.actor.path, ['next', '--stuck', 'waits on the schema']);
  assert.notEqual(noClaim.code, 0, noClaim.out);
  assert.equal(noClaim.document.error.code, 'USAGE');
  assert.match(noClaim.document.error.message, /pullboard next/u);
  assert.equal(store.getItem(box.board, held).item_owner, null, 'nothing was claimed');
  const claimed = await cli(box, box.seats.actor.path, ['claim', String(held)]);
  assert.equal(claimed.code, 0, claimed.out + claimed.err);
  const empty = await cli(box, box.seats.actor.path, ['next', '--stuck', ' ']);
  assert.notEqual(empty.code, 0, empty.out);
  assert.equal(empty.document.error.code, 'USAGE');
  assert.match(empty.document.error.message, /pullboard next/u);
  assert.equal(store.getItem(box.board, held).item_owner, box.seats.actor.id, 'the claim is still held');
  assert.deepEqual(releases(box, held), []);
});
