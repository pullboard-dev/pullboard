/** next and claim obey main's committed claims.perSeat, never the claiming seat's own checkout [C7,#10831]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { cli } from '../../fixtures/next/take.js';
import { fixture } from '../../fixtures/next/take.js';

/** Main sets claims.perSeat 1; the actor seat's own branch commits 5, as a seat on an older or edited checkout does. */
async function staleSeat(t) {
  const box = await fixture(t, { perSeat: 1 });
  const seat = box.seats.actor.path;
  const file = join(seat, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...config, claims: { ...config.claims, perSeat: 5 } }));
  box.git(seat, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-am', 'chore: seat raises its own claims.perSeat [G1]');
  const ids = ['first', 'second', 'third'].map(name => box.add(`Disjoint work ${name}`,
    { brief: `Files: web/${name}.js\nTest: the real board selects the item.` }));
  return { box, ids };
}

/** The actor seat's live build claims among the fixture items. */
const held = (box, ids) => ids.filter(id => {
  const item = store.getItem(box.board, id);
  return item.item_status === 'claimed' && item.item_owner === box.seats.actor.id;
});

test('cli.io-next-trunk-claims.next-claims-one-item-at-main-cap: clause 1: with main at claims.perSeat 1 and the seat branch at 5, next claims one item and seals claimsPerSeat 1 [C7,#10831]', async t => {
  const { box, ids } = await staleSeat(t);
  const taken = await cli(box, box.seats.actor.path, ['next']);
  assert.equal(taken.code, 0, taken.out + taken.err);
  const mine = held(box, ids);
  assert.equal(mine.length, 1, `next claimed ${mine.length} items; main's claims.perSeat is 1`);
  const event = box.board.db.prepare("SELECT event_detail d FROM event WHERE item_id = ? AND event_kind = 'claim' ORDER BY event_id DESC LIMIT 1").get(mine[0]);
  assert.equal(JSON.parse(event.d).claimsPerSeat, 1, 'the claim seals main\'s N, not the seat\'s 5');
});

test('cli.io-next-trunk-claims.second-claim-refused-at-main-cap: clause 2: production wiring: a second pullboard claim from that seat is refused at main\'s cap of 1 [C7,#10831]', async t => {
  const { box, ids } = await staleSeat(t);
  const first = await cli(box, box.seats.actor.path, ['claim', String(ids[0])]);
  assert.equal(first.code, 0, first.out + first.err);
  const second = await cli(box, box.seats.actor.path, ['claim', String(ids[1])]);
  assert.notEqual(second.code, 0, 'the second claim is refused');
  assert.match(second.out + second.err, /ONE_CLAIM[\s\S]*up to 1 \(claims\.perSeat sets 1\)/u);
  assert.deepEqual(held(box, ids), [ids[0]]);
});
