/** next and claim obey main's committed claims.perSeat, never the claiming seat's own checkout [C7,#10831]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
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

/** The actor seat's build claims: claimed by it and not waiting on its own gate, the claims a seat works on [C7]. */
const buildClaims = box => store.listItems(box.board).filter(item => item.item_status === 'claimed'
  && item.item_owner === box.seats.actor.id && !store.awaitingGateOrReview(box.board, item)).map(item => item.item_id);

test('cli.io-next-trunk-claims.next-never-stacks-child-slices: clause 3: at claims.perSeat 1, next over children of an unheld parent never leaves more than one build claim, before or after a submit [C7,#10846]', async t => {
  const box = await fixture(t, { perSeat: 1 });
  box.board.gitRoot = box.root;
  const seat = box.seats.actor;
  const parent = box.add('Umbrella item nobody holds', { brief: 'Files: web/umbrella.js\nTest: the real board selects the item.' });
  // The umbrella is held, as an umbrella whose slices are the work is; next offers only its children.
  store.holdItem(box.board, parent, { agentId: 'coordinator', reason: 'Umbrella item: its slices are the work' });
  const children = ['a', 'b', 'c', 'd'].map(name => box.add(`Slice ${name}`,
    { parentId: parent, brief: `Files: web/slice-${name}.js\nTest: the real board selects the item.` }));
  for (let call = 1; call <= 4; call += 1) {
    const taken = await cli(box, seat.path, ['next']);
    assert.equal(taken.code, 0, taken.out + taken.err);
    assert.equal(buildClaims(box).length, 1, `next call ${call} left build claims ${buildClaims(box).join(', ')}`);
  }
  const [first] = buildClaims(box);
  assert.ok(children.includes(first), 'the one claim is a slice');
  // The held slice's submit hand-off is queued, as pullboard submit leaves it while its gate runs.
  const head = box.git(seat.path, 'rev-parse', 'HEAD');
  const tree = box.git(box.root, 'rev-parse', `${head}^{tree}`);
  const job = store.writeBoardCommand(box.board, 'queueSubmitHandoff', [first, { agentId: seat.id, job: randomUUID(), main: head, commit: head, tree,
    executionCommit: head, executionTree: tree, digest: store.getItem(box.board, first).item_frozen_digest, companionDigest: null, leaseMs: 7_200_000 }], seat.id).job;
  store.startSubmitHandoff(box.board, first, { agentId: seat.id, job: job.id });
  assert.deepEqual(buildClaims(box), [], 'a claim waiting on its gate is not a build claim');
  for (let call = 1; call <= 3; call += 1) {
    const taken = await cli(box, seat.path, ['next']);
    assert.equal(taken.code, 0, taken.out + taken.err);
    assert.equal(buildClaims(box).length, 1, `next call ${call} after the submit left build claims ${buildClaims(box).join(', ')}`);
  }
  const owned = children.filter(id => store.getItem(box.board, id).item_owner === seat.id && store.getItem(box.board, id).item_status === 'claimed');
  assert.equal(owned.length, 2, 'the gated slice and one new slice; the other two stay open');
});
