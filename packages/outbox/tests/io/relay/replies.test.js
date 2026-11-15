/** @pullboard-test-loads packages/outbox/src/io/relay/ordering.js */
/** A lost relay reply is recovered once from the ordered log, and every replica agrees on the order and its refusals [H3,H16,V1,V17]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  move,
  replica,
  standInRelay,
  useBoardKey,
} from '../../fixtures/stand-in-relay.js';

/** A replica whose move reached the relay but whose reply was lost: the relay holds the event, the replica still holds `pending`. */
function lostReply(t, relay, lost) {
  const machine = replica(t, relay);
  const sealed = JSON.stringify(lost);
  const event = relay.post(lost, sealed);
  machine.state.pending = { move: lost, sequence: event.event_id, sealed };
  return machine;
}

test('lost-reply recovery: a move the relay took is recovered from the ordered log, never posted again [H3,H16,V1,V17]', async t => {
  useBoardKey(t);
  const relay = standInRelay();
  const machine = lostReply(t, relay, move('lost-add', 'addItem', 'web', 'Lost clone reply'));
  assert.equal(relay.posts, 1);
  await machine.catchUp();
  assert.equal(relay.posts, 1, 'recovery reads the relay and never posts the move again');
  assert.equal(machine.state.pending, undefined, 'the recovered move no longer waits');
  assert.equal(machine.state.recovered.move.id, 'lost-add', 'the original outcome is held for the retried command');
  assert.equal(machine.state.sequence, 1, 'the cursor is the sequence the relay gave the lost move');
  assert.deepEqual(machine.reported, ['lost-add'], 'the recovery is reported once');
  assert.ok(machine.receipt('lost-add'), 'the move has its one durable receipt');
  await machine.catchUp();
  assert.deepEqual(machine.reported, ['lost-add'], 'catching up again does not recover it a second time');
  assert.equal(machine.db.prepare("SELECT COUNT(*) AS n FROM board_meta WHERE meta_key LIKE 'relay_receipt_%'").get().n, 1);
});

test('lost-reply recovery: every operation whose reply is lost is recovered once, so submit, verify, edit and merge replies are not re-sent [H3,H16,V1,V17]', async t => {
  useBoardKey(t);
  const relay = standInRelay();
  const operations = [['appendFact', 2, 'Gate job g1 offered for #2'], ['verify', 2, 'accept'], ['editItem', 1, 'brief'], ['merged', 2, 'lost-merge-reference']];
  for (const [operation, ...args] of operations) {
    const machine = lostReply(t, relay, move(`lost-${operation}`, operation, ...args));
    const before = relay.posts;
    await machine.catchUp();
    assert.equal(relay.posts, before, `${operation}: no second post`);
    assert.equal(machine.state.recovered.move.operation, operation, `${operation}: its original outcome is held`);
    assert.deepEqual(machine.reported, [`lost-${operation}`], `${operation}: recovered once`);
  }
});

test('outcome ordering: the lost reply of a refused claim surfaces the relay\'s original rule after the winner, once [H3,H16,V1,V17]', async t => {
  useBoardKey(t);
  const relay = standInRelay();
  const winner = replica(t, relay);
  const loser = replica(t, relay);
  const first = move('claim-a', 'claim', 1, 'agent-a');
  const winnerEvent = relay.post(first, JSON.stringify(first));
  const second = move('claim-b', 'claim', 1, 'agent-b');
  const secondEvent = relay.post(second, JSON.stringify(second));
  loser.state.pending = { move: second, sequence: secondEvent.event_id, sealed: secondEvent.sealed };
  await assert.rejects(loser.catchUp(), error => error.code === 'HELD' && error.next === 'take another item: pullboard next');
  assert.equal(loser.state.pending, undefined, 'the refusal consumes the pending move');
  assert.deepEqual(loser.reported, ['claim-b']);
  assert.equal(loser.receipt('claim-a') !== null, true, 'the accepted claim is receipted on the losing replica too');
  assert.equal(loser.receipt('claim-b'), null, 'the refused claim leaves no accepted receipt');
  assert.deepEqual(loser.refusals.map(({ id, sequence }) => [id, sequence]), [['claim-b', secondEvent.event_id]]);
  assert.ok(winnerEvent.event_id < loser.refusals[0].sequence, 'the refusal follows the accepted competing claim in the order');
  await winner.catchUp();
  assert.equal(winner.state.sequence, loser.state.sequence, 'both replicas end at the same position');
  assert.deepEqual(winner.refusals, loser.refusals, 'both replicas record the same refusal at the same sequence');
});

test('outcome ordering: three replicas fed one relay order apply the same prefix and agree on every receipt [H3,H16,V1,V17]', async t => {
  useBoardKey(t);
  const relay = standInRelay();
  const replicas = [replica(t, relay), replica(t, relay), replica(t, relay)];
  for (const [index, operation] of ['addItem', 'claim', 'claim', 'editItem', 'verify'].entries()) {
    const posted = move(`m${index}`, operation, 1, `agent-${index}`);
    relay.post(posted, JSON.stringify(posted));
  }
  // Replicas read the same log at different times; a later reader still sees the same order.
  await replicas[0].catchUp().catch(() => {});
  await replicas[2].catchUp().catch(() => {});
  await replicas[1].catchUp().catch(() => {});
  assert.deepEqual(replicas.map(machine => machine.state.sequence), [5, 5, 5]);
  const receipts = replicas.map(machine => machine.db.prepare("SELECT meta_key, meta_value FROM board_meta WHERE meta_key LIKE 'relay_receipt_%' ORDER BY meta_key").all().map(row => [row.meta_key, row.meta_value]));
  assert.deepEqual(receipts[1], receipts[0]);
  assert.deepEqual(receipts[2], receipts[0]);
  assert.deepEqual(replicas[0].refusals.map(entry => [entry.id, entry.error.code]), [['m2', 'HELD']], 'the second claim of the item is the one refused');
});

test('receipt replay: a recovered descriptor with no durable receipt stays pending and is never taken as an outcome [H3,H16,V1,V17]', async t => {
  useBoardKey(t);
  const relay = standInRelay();
  const machine = replica(t, relay);
  const fabricated = move('fabricated-submit', 'submit', 7, { commit: 'f'.repeat(40) });
  // The relay never ordered this move: only the local descriptor exists, as a hand-written link file would leave it.
  machine.state.pending = { move: fabricated, sequence: 1, sealed: JSON.stringify(fabricated) };
  await machine.catchUp();
  assert.equal(machine.state.recovered, undefined, 'no receipt, no recovered outcome');
  assert.equal(machine.state.pending.move.id, 'fabricated-submit', 'the descriptor stays pending to be sent');
  assert.deepEqual(machine.reported, []);
  assert.equal(machine.receipt('fabricated-submit'), null);
  assert.equal(relay.posts, 0);
});

test('receipt replay: a receipt for a different sealed record is not this move\'s reply, so a refusal of the same id is not recovered [H3,H16,V1,V17]', async t => {
  useBoardKey(t);
  const relay = standInRelay();
  const machine = replica(t, relay);
  const other = move('claim-x', 'claim', 3, 'agent-x');
  relay.post(other, JSON.stringify(other));
  const ours = move('claim-y', 'claim', 3, 'agent-y');
  const sealed = JSON.stringify(ours);
  relay.post(move('claim-z', 'claim', 3, 'agent-z'), JSON.stringify(move('claim-z', 'claim', 3, 'agent-z')));
  machine.state.pending = { move: ours, sequence: 2, sealed };
  await machine.catchUp();
  assert.equal(machine.state.pending?.move.id, 'claim-y', 'ciphertext that differs from the pending send is not its interrupted reply');
  assert.deepEqual(machine.reported, []);
});
