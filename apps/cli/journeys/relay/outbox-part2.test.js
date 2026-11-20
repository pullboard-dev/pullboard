import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { join } from 'node:path';
import test from 'node:test';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { twoMachines } from '../../tests/fixtures/relay/outbox.js';
import { milestoneItems } from '../../tests/fixtures/relay/outbox.js';

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

test('cli.journeys-relay-outbox-part2.a-milestone-edit-naming-an-offline: a milestone edit naming an offline item follows that item when another machine takes its number first [B26,H16,H17]', async (t) => {
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
