import { recordedRelayRefusal } from '../../tests/fixtures/relay/refusal.js';
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { MOVE_OPERATIONS as ENGINE_OPERATIONS } from '../../../../packages/moves/index.js';
import { rememberCreatedItems } from '../../../../packages/link/index.js';
import {
  ITEM_SLOTS,
  bindRefs,
  resolveMove,
  strayItemRefs,
} from '../../../../packages/outbox/index.js';
import {
  runFixtureGit,
  runFixtureSetupGit,
} from '../../tests/fixtures/child.js';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';
import { Refused } from '../../../../packages/kernel/light.js';
import { outboxQueueable } from '../../../../packages/outbox/index.js';


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

/** The shout texts a board export holds, in board order. */
function shoutTexts(exported) {
  return exported.tables.shout.map((row) => row.shout_text);
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

test('a move on an accepted relay link waits in the ordered outbox while the relay is down, and replays in order [B26,H16,H17]', async (t) => {
  const { box, other, contested } = await twoMachines(t, 'Contested while the relay is down');

  await box.stopRelay();
  const first = await box.cliLocal('shout', 'all', 'queued first while the relay is down');
  assert.equal(first.code, 0, JSON.stringify(first.document));
  const withdrawn = await box.cliLocal('withdraw', String(contested), 'queued withdraw from this machine');
  assert.equal(withdrawn.code, 0, withdrawn.failure);
  const last = await box.cliLocal('shout', 'all', 'queued last while the relay is down');
  assert.equal(last.code, 0, last.failure);

  const waiting = await box.cliLocal('status');
  assert.deepEqual(waiting.document.relay.outbox.map((move) => [move.operation, move.item]), [['shout', null], ['withdraw', contested], ['shout', null]],
    'pullboard status lists the queued moves in the order they were made');
  const shown = await box.cliLocal('show', String(contested));
  assert.deepEqual(shown.document.relayPending.map((move) => move.operation), ['withdraw'], 'the item shows its move as pending');
  const local = await box.cliLocal('export');
  assert.ok(shoutTexts(local.document).includes('queued last while the relay is down'), 'this machine keeps working on its queued moves');

  await box.restartRelay();
  // One main checkout coordinates at a time (E19, #347): the other machine takes the coordinator before it withdraws.
  const taken = await other.cli('takeover');
  assert.equal(taken.code, 0, taken.failure);
  const raced = await other.cli('withdraw', String(contested), 'the other machine withdrew it first');
  assert.equal(raced.code, 0, raced.failure);

  const replayed = await box.cliLocal('status');
  assert.equal(replayed.code, 0, replayed.failure);
  assert.equal(replayed.document.relay.outbox, undefined, 'the outbox is empty once it replays');
  const refusals = replayed.document.relay.outboxRefusals;
  assert.deepEqual(refusals.map((refused) => refused.move.split(' ')[0]), ['shout', 'withdraw', 'shout'], 'each queued move replays in the order it was made');
  for (const refused of refusals) {
    assert.equal(refused.code, 'COORDINATOR_HELD', 'a queued coordinator move from the machine that no longer holds the coordinator is refused');
    assert.ok(refused.message.includes(`computer ${other.machine.slice(-8)}`), 'the refusal names the machine that holds the coordinator');
  }
  assert.ok(refusals[1].earlier.some((earlier) => earlier.move.startsWith(`withdraw #${contested}`)), 'the refusal names the move another machine made first');

  const there = await other.cli('export');
  const here = await box.cliLocal('export');
  const sent = shoutTexts(there.document).filter((text) => /while the relay is down/u.test(text));
  assert.deepEqual(sent, [], 'no queued coordinator move reaches the other machine');
  assert.deepEqual(shoutTexts(here.document), shoutTexts(there.document), 'both machines hold the same shouts in the same order');
  const item = (exported) => exported.tables.item.find((row) => row.item_id === contested);
  assert.deepEqual(item(here.document), item(there.document), 'both machines agree on the contested item');
  assert.equal(item(there.document).item_status, 'withdrawn');
});

test('a queued move names an offline item by the add that made it, never by a number [B26,H16]', () => {
  const add = (id, visible) => ({ move: { id, operation: 'addItem', args: [{ by: 'coordinator', lane: 'app', title: id }] }, visible });
  const outbox = { moves: [add('a', 2), add('b', 3)], results: {} };
  const withdraw = { id: 'w', operation: 'withdraw', args: [3, { agentId: 'coordinator', reason: 'r' }] };
  const child = { id: 'c', operation: 'addItem', args: [{ by: 'coordinator', lane: 'app', title: 't', parentId: 2, after: [3, 9] }] };
  const queued = { move: withdraw, refs: bindRefs(outbox, withdraw) };
  const nested = { move: child, refs: bindRefs(outbox, child) };
  assert.deepEqual(queued.refs, [{ path: [0], add: 'b' }], 'the number is bound to the add that made it; #9 is a board item');
  outbox.moves[1].visible = 4;
  assert.equal(resolveMove(queued, outbox, { local: true }).move.args[0], 4, 'here it follows the number this machine shows now');
  outbox.results = { a: 3, b: 5 };
  assert.equal(resolveMove(queued, outbox).move.args[0], 5, 'at replay it takes the number the relay gave');
  assert.equal(queued.move.args[0], 3, 'the queued move itself is never rewritten');
  assert.deepEqual(resolveMove(nested, outbox).move.args[0], { by: 'coordinator', lane: 'app', title: 't', parentId: 3, after: [5, 9] });
  const answer = { id: 'q', operation: 'answerDecision', args: [3, { agentId: 'coordinator', answer: 'yes' }] };
  assert.deepEqual(bindRefs(outbox, answer), [], 'a decision number is a shout, never an item');
  outbox.results = { a: 3, b: null };
  assert.deepEqual(resolveMove(queued, outbox).lost, [3], 'a move on an item whose add was refused is named, not sent');
});

/** The milestones a board export holds, by name, with their item numbers as numbers. */
function milestoneItems(exported) {
  const row = exported.tables.board_meta.find((meta) => meta.meta_key === 'milestones');
  return Object.fromEntries(JSON.parse(row?.meta_value ?? '[]').map((milestone) => [milestone.name, milestone.items.map(Number)]));
}

test('every ordered move kind says where it names an item, and each place follows an offline item renumbered at replay [B26,H16]', () => {
  assert.deepEqual(ENGINE_OPERATIONS.filter((operation) => !Object.hasOwn(ITEM_SLOTS, operation)), [], 'every engine operation declares its item places, even when it has none');
  assert.deepEqual(Object.keys(ITEM_SLOTS).filter((operation) => !ENGINE_OPERATIONS.includes(operation)), [], 'no declaration names an operation the engine lacks');
  /** Build arguments that hold `value` at one declared place, with a list of one where the pattern has `*`. */
  const holding = (pattern, value) => {
    const args = [];
    let at = args;
    pattern.forEach((key, index) => {
      const last = index === pattern.length - 1;
      const next = last ? value : pattern[index + 1] === '*' ? [] : {};
      if (key === '*') at.push(next); else at[key] = next;
      at = key === '*' ? at.at(-1) : at[key];
    });
    return args;
  };
  const outbox = { moves: [{ move: { id: 'offline-add', operation: 'addItem', args: [{}] }, visible: 7 }], results: { 'offline-add': 12 } };
  let places = 0;
  for (const [operation, patterns] of Object.entries(ITEM_SLOTS)) {
    for (const pattern of patterns) {
      for (const value of pattern.at(-1) === '*' ? [7, '7', '#7'] : [7]) {
        const move = { id: `${operation}-${places}`, operation, args: holding(pattern, value) };
        const entry = { move, refs: bindRefs(outbox, move) };
        assert.equal(entry.refs.length, 1, `${operation} binds the offline item at ${pattern.join('.')} (${JSON.stringify(value)})`);
        const sent = resolveMove(entry, outbox).move;
        const written = entry.refs[0].path.reduce((held, key) => held[key], sent.args);
        assert.deepEqual(written, typeof value === 'string' ? value.replace('7', '12') : 12, `${operation} sends the relay's number at ${pattern.join('.')}, in the form it was given`);
        assert.equal(strayItemRefs(outbox, move).length, 0, `${operation}'s declared place is never treated as stray`);
        places += 1;
      }
    }
  }
  assert.ok(places >= 30, `the walk covers every declared place (${places})`);
});

test('re-home reservation and delivery moves always require relay order [E15,H16]', () => {
  const state = { mode: 'ordered', baselineAccepted: true, baselineConflict: false, environment: false };
  const io = { relayOutbox: () => true };
  const unavailable = new Refused('RELAY_UNAVAILABLE', 'the relay did not answer');
  const itemSlots = { reserveRehomeItemId: [], rehomeItem: [[0]], applyRehomeItem: [[0, 'destinationItemId']] };
  for (const operation of ['reserveRehomeItemId', 'rehomeItem', 'applyRehomeItem']) {
    assert.deepEqual(ITEM_SLOTS[operation], itemSlots[operation], `${operation} declares only its local item IDs`);
    assert.equal(outboxQueueable(state, unavailable, operation, io), false, `${operation} waits for an acknowledged result`);
  }
});

test('a move that names an offline item where the outbox cannot follow it is refused, never sent [B26,H16]', () => {
  const outbox = { moves: [{ move: { id: 'offline-add', operation: 'addItem', args: [{}] }, visible: 7 }] };
  assert.deepEqual(strayItemRefs(outbox, { operation: 'recordHealthFindings', args: [{ agentId: 'coordinator', findings: [{ item: 7, cause: 'x' }] }] }), [7]);
  assert.deepEqual(strayItemRefs(outbox, { operation: 'answerDecision', args: [7, { agentId: 'coordinator', text: 'yes' }] }), [], 'a decision number is a shout, never an item');
  assert.deepEqual(strayItemRefs(outbox, { operation: 'recordAttempt', args: [3, { agentId: 'core-1', n: 7, seconds: 7 }] }), [], 'counts and durations are not items');
});

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
