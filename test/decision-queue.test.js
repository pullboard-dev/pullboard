/** Public real-CLI/SQLite decision queue, claim retention and person boundary [B7,B21,B26,B27]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../src/board.js';
import {
  prepareEngineMove,
  applyEngineMove,
} from '../src/engine.js';
import {
  exportBoard,
  importBoard,
} from '../src/exchange.js';
import { DECISION_QUEUE_ENGINE } from '../src/decision-queue-engine.js';
import { createE2eHelpers } from './e2e-helpers.js';

/** Run an authenticated private-board CLI command and decode its public response. */
function document(box, cwd, ...args) {
  const result = box.run(cwd, ...args, '--json');
  assert.equal(result.code, 0, result.err || result.out);
  return JSON.parse(result.out);
}

test('a decision asked on an item is answered from the queue and recorded on the item [B7,B21,B26,B27]', async (t) => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const added = document(box, box.repo, 'add', 'web', 'Keep building while a choice is pending',
    '--criterion', 'The page renders.', '--specs', 'G1');
  const item = { id: added.item.item_id };
  document(box, box.web, 'claim', String(item.id));
  const before = document(box, box.web, 'show', String(item.id));
  const options = ['Keep the local interface', 'Use the shared interface'];
  const question = 'Which interface should this item expose?';
  const ask = document(box, box.web, 'shout', 'coordinator', question,
    '--item', String(item.id), '--decision', '--options', JSON.stringify(options));
  const pending = document(box, box.web, 'show', String(item.id));
  assert.equal(pending.item_status, 'claimed');
  assert.equal(pending.item_owner, before.item_owner);
  assert.equal(pending.item_lease_until, before.item_lease_until, 'asking neither releases nor renews the claim');
  const ordinary = document(box, box.web, 'shout', 'all', 'Implementation continues while the answer is pending.');
  const queue = document(box, box.repo, 'decisions');
  const queued = queue.decisions.find(row => row.shout_id === ask.id);
  assert.ok(queued, 'the coordinator has a separate open decision queue');
  assert.deepEqual(queued.options, options);
  assert.equal(queued.item, item.id);
  assert.equal(queue.decisions.some(row => row.shout_id === ordinary.id), false);
  const view = await helpers.startView(box, box.repo);
  t.after(view.stop);
  const feed = (await view.state(box.repo)).project;
  assert.ok(Array.isArray(feed.decisionQueue), 'the feed exposes a distinct coordinator queue');
  assert.deepEqual(feed.decisionQueue.find(row => row.shout_id === ask.id).options, options);
  assert.equal(feed.decisionQueue.some(row => row.shout_id === ordinary.id), false);
  assert.ok(feed.shouts.some(row => row.shout_id === ordinary.id), 'ordinary shouts remain in the stream');
  const answer = document(box, box.repo, 'answer', String(ask.id), options[1]);
  assert.equal(document(box, box.repo, 'decisions').decisions.some(row => row.shout_id === ask.id), false);
  const answered = document(box, box.web, 'show', String(item.id));
  assert.ok(answered.thread.some(row => row.kind === 'answer' && row.detail.text === options[1]),
    'a fresh CLI process reads the durable item answer');
  const inbox = document(box, box.web, 'inbox');
  assert.ok(inbox.shouts.some(row => row.shout_id === answer.id && row.shout_text === options[1]));
  assert.equal(answered.item_status, 'claimed');
  assert.equal(answered.item_owner, before.item_owner);
  assert.equal(answered.item_lease_until, before.item_lease_until);
  const duplicate = box.run(box.repo, 'answer', String(ask.id), options[0], '--json');
  assert.notEqual(duplicate.code, 0);
  assert.equal(JSON.parse(duplicate.out).error.code, 'ALREADY_ANSWERED');
  const personal = document(box, box.web, 'shout', 'coordinator', 'May the public policy change?',
    '--item', String(item.id), '--decision', '--options', JSON.stringify(['Approve', 'Decline']));
  const passed = document(box, box.repo, 'pass', String(personal.id), 'Only the person can approve policy.');
  const needs = document(box, box.repo, 'resume').needsYou;
  assert.ok(needs.some(row => row.kind === 'decision' && row.id === passed.id));
  const forbidden = box.run(box.repo, 'answer', String(passed.id), 'Approve', '--json');
  assert.notEqual(forbidden.code, 0);
  assert.equal(JSON.parse(forbidden.out).error.code, 'B26_PERSON_ANSWER');
  assert.ok(document(box, box.repo, 'resume').needsYou.some(row => row.id === passed.id),
    'the coordinator cannot clear a person-only choice');
  document(box, box.repo, 'answer', String(passed.id), 'Decline', '--as', 'person');
  assert.equal(document(box, box.repo, 'resume').needsYou.some(row => row.id === passed.id), false);
  assert.ok(document(box, box.web, 'inbox').shouts.some(row => /Person answered/.test(row.shout_text)));
});


test('item decision options replay exactly and never acquire legacy engine authority [B21,H3,H16]', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-decision-queue-'));
  const source = store.openBoard(join(directory, 'source.sqlite'));
  const replica = store.openBoard(join(directory, 'replica.sqlite'));
  const restored = store.openBoard(join(directory, 'restored.sqlite'));
  t.after(() => {
    for (const board of [source, replica, restored]) store.closeBoard(board);
    rmSync(directory, { recursive: true, force: true });
  });
  store.register(source, { lane: 'coordinator', path: '/decision-root' });
  store.register(source, { lane: 'web', path: '/decision-root/web-1' });
  store.register(source, { lane: 'web', path: '/decision-root/web-2' });
  const id = store.addItem(source, { by: 'coordinator', lane: 'web', title: 'Replica choice' });
  store.claim(source, id, { agentId: 'web-1', lane: 'web', leaseMs: 7_200_000,
    freeze: () => ({ text: '{"rows":[]}', digest: 'd'.repeat(64) }) });
  importBoard(replica, exportBoard(source));
  const message = { from: 'web-1', to: 'coordinator', item: id, text: 'Which shape?', decision: true,
    options: ['Small', 'Shared'], lanes: ['coordinator', 'web'] };
  const move = prepareEngineMove(source, 'shout', [message], { id: 'item-decision', actor: 'web-1' });
  const at = new Date().toISOString();
  assert.throws(() => applyEngineMove(replica, { ...move, engine: DECISION_QUEUE_ENGINE - 1 }, { sequence: 1, at }), /RELAY_MOVE/);
  assert.deepEqual(store.openDecisions(replica), [], 'a legacy engine cannot silently discard the options');
  const answer = applyEngineMove(replica, move, { sequence: 1, at });
  assert.ok(answer);
  assert.deepEqual(store.openDecisions(replica, 'coordinator').map(row => ({ item: row.item, options: row.options })),
    [{ item: id, options: ['Small', 'Shared'] }]);
  importBoard(restored, exportBoard(replica));
  assert.deepEqual(store.openDecisions(restored), store.openDecisions(replica), 'snapshot restores the exact pending choices');
  const before = store.events(replica).length;
  for (const options of [[], ['Only'], ['Same', 'Same'], ['A', ' '], 'not an array']) {
    assert.throws(() => store.shout(replica, { ...message, options }), /BAD_DECISION_OPTIONS/);
  }
  assert.throws(() => store.shout(replica, { ...message, from: 'web-2' }), /NOT_YOUR_ITEM_DECISION/);
  assert.equal(store.events(replica).length, before, 'refused choices append no successful decision');
  const legacy = prepareEngineMove(replica, 'shout', [{ from: 'web-1', to: 'coordinator', text: 'Old question',
    decision: true, lanes: ['coordinator', 'web'] }], { id: 'legacy-decision', actor: 'web-1' });
  applyEngineMove(replica, { ...legacy, engine: 1 }, { sequence: 2, at });
  assert.equal(store.openDecisions(replica).find(row => row.shout_text === 'Old question').options, undefined);
  const opaque = prepareEngineMove(replica, 'shout', [{ from: 'web-2', to: 'coordinator', text: 'Legacy opaque detail',
    decision: true, lanes: ['coordinator', 'web'], detail: { item: id, decisionOptions: ['Injected A', 'Injected B'] } }],
  { id: 'legacy-opaque-detail', actor: 'web-2' });
  applyEngineMove(replica, { ...opaque, engine: 1 }, { sequence: 3, at });
  const legacyOpaque = store.openDecisions(replica).find(row => row.shout_text === 'Legacy opaque detail');
  assert.equal(legacyOpaque.options, undefined, 'old opaque detail must not acquire new option meaning or item authority');
  assert.equal(replica.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`item_decision:${legacyOpaque.shout_id}`),
    undefined, 'legacy engine data creates no new decision index');
  assert.deepEqual(JSON.parse(store.events(replica).at(-1).event_detail).decisionOptions, ['Injected A', 'Injected B'],
    'the legacy opaque event data itself is retained without rewriting history');
});
