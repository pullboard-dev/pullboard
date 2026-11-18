import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { runFixtureSetupGit } from '../../tests/fixtures/child.js';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';

/** Turn the board's committed relay.outbox setting on, as its coordinator would. */
function enableOutbox(box) {
  const file = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...config, relay: { outbox: true } }, null, 2) + '\n');
  // The board's own commit hook runs pullboard, so this private PATH gets the CLI under test.
  const cliPath = fileURLToPath(new URL('../../pullboard.js', import.meta.url));
  writeFileSync(join(box.env.PATH, 'pullboard'), `#!/bin/sh\nexec node "${cliPath}" "$@"\n`, { mode: 0o700 });
  runFixtureGit(['add', 'pullboard.json'], { cwd: box.root, env: box.env });
  // Setup commit without hooks (two Node launches); no case here is about the commit hook [C7].
  runFixtureSetupGit(['commit', '-q', '-m', 'chore(config): queue relay moves while the relay is down'], { cwd: box.root, env: box.env });
}

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

/** Two machines on one accepted relay board with the outbox on, and an item added before the outage. */
async function twoMachines(t, title, { beforeLink } = {}) {
  const box = await relayClientFixture(t);
  enableOutbox(box);
  await beforeLink?.(box);
  await box.link();
  const contested = (await box.cliLocal('add', box.lane, title)).document.item.item_id;
  const printed = await box.cliLocal('relay', 'pair');
  const other = await box.otherDeviceJoin(printed.document.code, undefined, { inProcess: true });
  assert.equal(JSON.parse(readFileSync(box.linkFile, 'utf8')).baselineAccepted, true, 'the relay accepted this board before the outage');
  return { box, other, contested };
}

test('cli.journeys-relay-outbox-offline.an-item-added-while-the-relay: clause 1: an item added while the relay is down keeps its queued moves when another machine adds one first [B26,H16,H17]', async (t) => {
  const { box, other } = await twoMachines(t, 'Added before the outage');
  await box.stopRelay();
  const added = await box.cliLocal('add', box.lane, 'Added here while the relay is down');
  assert.equal(added.code, 0, JSON.stringify(added.document));
  const local = added.document.item.item_id;
  const second = await box.cliLocal('add', box.lane, 'Also added here while the relay is down');
  assert.equal(second.document.item.item_id, local + 1, 'the second offline add takes the next local number');
  const withdrawn = await box.cliLocal('withdraw', String(local), 'withdrawn here while the relay is down');
  assert.equal(withdrawn.code, 0, withdrawn.failure);

  await box.restartRelay();
  const first = await (await otherAgent(box, other))('add', box.lane, 'Added there first');
  assert.equal(first.code, 0, first.failure);
  assert.equal(first.document.item.item_id, local, 'the other machine takes the number this machine used offline');

  const replayed = await box.cliLocal('status');
  assert.equal(replayed.code, 0, replayed.failure);
  assert.equal(replayed.document.relay.outbox, undefined, 'the outbox is empty once it replays');
  assert.equal(replayed.document.relay.outboxRefusals, undefined, 'nothing is refused: the queued withdraw follows its own item');
  assert.deepEqual(replayed.document.relay.outboxRenumbered, [{ was: local, is: local + 1 }, { was: local + 1, is: local + 2 }],
    'status says each offline item got the next number');
  for (const machine of [box, other]) {
    const items = new Map((await machine.cli('export')).document.tables.item.map((row) => [row.item_id, row]));
    assert.deepEqual([items.get(local).item_title, items.get(local).item_status], ['Added there first', 'open'], 'the other machine\'s item is untouched');
    assert.deepEqual([items.get(local + 1).item_title, items.get(local + 1).item_status], ['Added here while the relay is down', 'withdrawn'], 'the queued withdraw acts on the item it was made for');
    assert.deepEqual([items.get(local + 2).item_title, items.get(local + 2).item_status], ['Also added here while the relay is down', 'open'],
      'a later renumbering never moves a target that was already mapped');
  }
});

test('cli.journeys-relay-outbox-offline.an-offline-hand-off-keeps-its: clause 2: an offline hand-off keeps its own item number after another machine adds [B3,B26,H16,H17]', async (t) => {
  const { box, other } = await twoMachines(t, 'Before the offline hand-off');
  /** Join a real local worktree before the outage so both hand-off actors have authenticated seats. */
  async function seat(name) {
    const path = join(dirname(box.root), name);
    runFixtureGit(['worktree', 'add', '-q', '-b', `agent/${name}`, path], { cwd: box.root, env: box.env });
    const joined = await box.cliAtLocal(path, 'join', box.lane, '--model', 'fixture-model');
    assert.equal(joined.code, 0, joined.failure);
    return { path, id: joined.document.agent };
  }
  const outgoing = await seat('outgoing');
  const incoming = await seat('incoming');
  await box.stopRelay();
  const opened = await box.cliAtLocal(outgoing.path, 'handoff');
  assert.equal(opened.code, 0, opened.failure);
  const local = opened.document.handoff.item;
  const fact = await box.cliAtLocal(outgoing.path, 'fact', String(local), 'note', 'Keep this note on its own hand-off');
  assert.equal(fact.code, 0, fact.failure);
  const taken = await box.cliAtLocal(incoming.path, 'handoff', '--take', String(local));
  assert.equal(taken.code, 0, taken.failure);
  assert.equal(taken.document.handoff.item, local);

  await box.restartRelay();
  const remote = await (await otherAgent(box, other))('add', box.lane, 'Remote item takes the offline number');
  assert.equal(remote.code, 0, remote.failure);
  assert.equal(remote.document.item.item_id, local);
  const replayed = await box.cliLocal('status');
  assert.equal(replayed.code, 0, replayed.failure);
  assert.equal(replayed.document.relay.outboxRefusals, undefined, 'the fact and take follow their own hand-off instead of the remote item');
  assert.deepEqual(replayed.document.relay.outboxRenumbered, [{ was: local, is: local + 1 }]);
  for (const machine of [box, other]) {
    const exported = await machine.cli('export');
    const tables = exported.document.tables;
    assert.equal(tables.item.find(row => row.item_id === local).item_title, 'Remote item takes the offline number');
    const thread = await machine.cli('show', String(local + 1));
    assert.equal(thread.code, 0, thread.failure);
    const notes = tables.event.filter(row => row.event_kind === 'fact' && JSON.parse(row.event_detail).text === 'Keep this note on its own hand-off');
    assert.equal(notes.length, 1, 'the original fact is recorded once');
    assert.equal(notes[0].item_id, local + 1, 'the fact is bound to the hand-off');
    const takes = tables.event.filter(row => row.event_kind === 'handoff-take');
    assert.equal(takes.length, 1, 'the incoming seat takes over once');
    assert.equal(takes[0].item_id, local + 1, 'the take is bound to the hand-off');
  }
});

test('cli.journeys-relay-outbox-offline.an-offline-item-stays-bound-to: clause 3: an offline item stays bound to its queued moves through a replay that stops part way and new work after it [B26,H16,H17]', async (t) => {
  const { box, other } = await twoMachines(t, 'Added before the outage');
  await box.stopRelay();
  const first = (await box.cliLocal('add', box.lane, 'First item added here offline')).document.item.item_id;
  const second = (await box.cliLocal('add', box.lane, 'Second item added here offline')).document.item.item_id;
  await box.restartRelay();
  const agent = await otherAgent(box, other);
  assert.equal((await agent('add', box.lane, 'Remote item takes the first number')).document.item.item_id, first);
  // The relay takes the first replayed add, then stops answering reads and moves, so the replay stops part way.
  box.beforeNextMove(() => { box.refuseReads(true); box.refuseMoves(true); });
  await box.cliLocal('status');
  const shown = (await box.cliLocal('export')).document.tables.item.find((row) => row.item_title === 'Second item added here offline').item_id;
  assert.notEqual(shown, second, 'the part-way replay shows the second item under a new number here');
  const withdrawn = await box.cliLocal('withdraw', String(shown), 'withdrawn here at the number this machine shows');
  assert.equal(withdrawn.code, 0, withdrawn.failure);
  box.refuseReads(false);
  box.refuseMoves(false);
  assert.equal((await agent('add', box.lane, 'Remote item takes the shown number')).document.item.item_id, shown,
    'the other machine takes the number this machine showed');

  const replayed = await box.cliLocal('status');
  assert.equal(replayed.code, 0, replayed.failure);
  assert.equal(replayed.document.relay.outbox, undefined, 'the outbox is empty once it replays');
  for (const machine of [box, other]) {
    const items = new Map((await machine.cli('export')).document.tables.item.map((row) => [row.item_title, row.item_status]));
    assert.equal(items.get('Remote item takes the shown number'), 'open', 'the other machine\'s item is untouched');
    assert.equal(items.get('Remote item takes the first number'), 'open');
    assert.equal(items.get('Second item added here offline'), 'withdrawn', 'the withdraw acts on the item it was made for');
  }
});
