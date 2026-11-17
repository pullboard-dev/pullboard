import { recordedRelayRefusal } from '../../tests/fixtures/relay/refusal.js';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { join } from 'node:path';
import test from 'node:test';
import { rememberCreatedItems } from '../../../../packages/link/index.js';
import { bindRefs } from '../../../../packages/outbox/index.js';
import { resolveMove } from '../../../../packages/outbox/index.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { milestoneItems } from '../../tests/fixtures/relay/outbox.js';
import { twoMachines } from '../../tests/fixtures/relay/outbox.js';

/**
 * An agent seat on the other machine. Its moves are its own, so it adds while the first machine's main checkout
 * keeps the coordinator: one main checkout coordinates a board at a time (E19, #347).
 */
async function otherAgent(box, other) {
  const path = join(dirname(other.root), 'other-agent');
  runFixtureGit(['worktree', 'add', '-q', '-b', 'agent/other', path], { cwd: other.root, env: other.env });
  /** Run the CLI in-process in the other machine's agent worktree. */
  const run = (...args) => other.cliAtLocal(path, ...args);
  const joined = await run('join', box.lane, '--model', 'fixture-model');
  assert.equal(joined.code, 0, joined.failure);
  return run;
}

test('a milestone edit naming an offline item follows that item when another machine takes its number first [B26,H16,H17]', async (t) => {
  // The milestone is part of the linked baseline, as on a board that already had one before the outage.
  const { box, other } = await twoMachines(t, 'Added before the outage', {
    beforeLink: async (unlinked) => {
      assert.equal((await unlinked.cli('milestone', 'add', 'next')).code, 0);
      assert.equal((await unlinked.cli('milestone', 'add', 'target')).code, 0);
    },
  });
  await box.stopRelay();
  const added = await box.cliLocal('add', box.lane, 'Added here while the relay is down');
  const local = added.document.item.item_id;
  const listed = await box.cliLocal('milestone', 'items', 'target', '--add', String(local), '--reason', 'Exercise offline milestone item remapping');
  assert.equal(listed.code, 0, listed.failure + JSON.stringify(listed.document));
  await box.restartRelay();
  assert.equal((await (await otherAgent(box, other))('add', box.lane, 'Added there first')).document.item.item_id, local, 'the other machine takes the number used offline');

  const replayed = await box.cliLocal('status');
  assert.equal(replayed.code, 0, replayed.failure);
  assert.equal(replayed.document.relay.outboxRefusals, undefined, 'nothing is refused');
  for (const machine of [box, other]) {
    const exported = (await machine.cli('export')).document;
    const titles = new Map(exported.tables.item.map((row) => [row.item_id, row.item_title]));
    assert.deepEqual(milestoneItems(exported).target.map((id) => titles.get(id)), ['Added here while the relay is down'],
      'the milestone holds the item this machine added, not the other machine\'s');
  }
});

test('a relay refusal after a recorded move says it was recorded [C6,N26,H16]', recordedRelayRefusal);


test('created-item bindings distinguish repair outputs and survive reordered multi-repair results [B26,H16,H17]', () => {
  const publication = { move: { id: 'publication', operation: 'recordPublishFinding' } };
  rememberCreatedItems(publication, { item: 9, repair: 12 });
  const gate = { move: { id: 'gate', operation: 'recordGateRun' } };
  rememberCreatedItems(gate, { quarantined: [{ file: 'test/a.test.js', name: 'a', item: 13 },
    { file: 'test/b.test.js', name: 'b', item: 14 }] });
  const outbox = { moves: [publication, gate], results: {} };
  const move = { operation: 'addItem', args: [{ parentId: 12, after: [13, 14, 9] }] };
  const entry = { move, refs: bindRefs(outbox, move) };
  assert.equal(entry.refs.length, 3, 'the original publication item is not a newly created repair');
  outbox.results.publication = { item: 9, repair: 22 };
  outbox.results.gate = { quarantined: [{ file: 'test/b.test.js', name: 'b', item: 24 },
    { file: 'test/a.test.js', name: 'a', item: 23 }] };
  const resolved = resolveMove(entry, outbox);
  assert.deepEqual(resolved.move.args, [{ parentId: 22, after: [23, 24, 9] }]);
  assert.deepEqual(resolved.lost, []);
  outbox.results.gate.quarantined.shift();
  assert.deepEqual(resolveMove(entry, outbox).lost, [14], 'a missing repair is lost rather than bound to a different array member');
  outbox.results.publication = null;
  assert.deepEqual(resolveMove(entry, outbox).lost, [12, 14], 'a refused creator cannot redirect its dependent move');
  rememberCreatedItems(gate, { quarantined: [{ file: 'test/a.test.js', name: 'a', item: 33 },
    { file: 'test/b.test.js', name: 'b', item: 34 }] });
  rememberCreatedItems(publication, { item: 9, repair: 32 });
  assert.deepEqual(resolveMove(entry, outbox, { local: true }).move.args, [{ parentId: 32, after: [33, 34, 9] }],
    'partial replay uses each newly shown local repair identity');
});

test('selector gap binds only a newly filed repair item [B26,H16]', () => {
  const created = { move: { id: 'gap', operation: 'recordSelectorGap' } };
  rememberCreatedItems(created, { item: 7, filed: true });
  const existing = { move: { id: 'existing', operation: 'recordSelectorGap' } };
  rememberCreatedItems(existing, { item: 9, filed: false });
  assert.deepEqual(existing.created, [], 'an existing repair is not newly created');
  const outbox = { moves: [created, existing], results: { gap: { item: 12, filed: true } } };
  const move = { operation: 'addItem', args: [{ parentId: 7, after: [9] }] };
  const refs = bindRefs(outbox, move);
  assert.equal(refs.length, 1, 'only the newly filed item receives a binding');
  assert.deepEqual(resolveMove({ move, refs }, outbox).move.args, [{ parentId: 12, after: [9] }]);
});
