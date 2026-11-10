/** Reads agents scripted become commands: inbox --history --since, and --fields on every JSON read [N2,A1]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { selectFields } from '../../../../packages/config/index.js';
import { join } from 'node:path';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

/** Run a real CLI read and parse its one JSON document. */
function json(box, cwd, ...args) {
  const result = box.run(cwd, ...args, '--json');
  return { code: result.code, document: JSON.parse(result.out) };
}

/** A real project with a web seat, one item and three shouts, one of them a coordinator question. */
function board() {
  const box = helpers.project('true');
  assert.equal(fixtureAdd(box.run, box.repo, 'web', 'Filtered read item', '--specs', 'G1', '--criterion', 'reads are filtered').code, 0);
  for (const args of [[box.repo, 'shout', 'web', 'first note'], [box.web, 'shout', 'coordinator', '--kind', 'question', 'second ask'],
    [box.repo, 'shout', 'web', 'third note']]) assert.equal(box.run(...args).code, 0, args.join(' '));
  return box;
}

test('inbox --history --since returns only newer shouts, filters by recipient and kind, and changes no inbox state [N2,A1]', () => {
  const box = board();
  const events = json(box, box.repo, 'log').document.events.length;
  const all = json(box, box.web, 'inbox', '--history', '--since', '0').document.shouts;
  const texts = all.map(row => row.shout_text);
  for (const text of ['first note', 'second ask', 'third note']) assert.ok(texts.includes(text), text);
  const first = all.find(row => row.shout_text === 'first note').shout_id;
  const newer = json(box, box.web, 'inbox', '--history', '--since', String(first)).document;
  assert.ok(newer.shouts.length > 0 && newer.shouts.every(row => row.shout_id > first), 'only shouts after the cursor');
  assert.equal(newer.next, newer.shouts.at(-1).shout_id, 'the reply names the id to continue from');
  assert.deepEqual(json(box, box.web, 'inbox', '--history', '--since', String(first), '--to', 'web').document.shouts.map(row => row.shout_text), ['third note']);
  assert.deepEqual(json(box, box.web, 'inbox', '--history', '--since', '0', '--kind', 'question').document.shouts.map(row => row.shout_text), ['second ask']);
  assert.equal(json(box, box.repo, 'log').document.events.length, events, 'a history read records no event');
  const delivered = json(box, box.web, 'inbox').document.shouts.map(row => row.shout_text);
  for (const text of ['first note', 'third note']) assert.ok(delivered.includes(text), `history left ${text} undelivered`);
  const refused = json(box, box.web, 'inbox', '--history', '--since', 'yesterday');
  assert.notEqual(refused.code, 0);
  assert.equal(refused.document.error.code, 'INBOX_SINCE');
});

test('--fields trims show, list, queue and inbox to the named keys and leaves refusals whole [N2,A1]', () => {
  const box = board();
  const id = json(box, box.repo, 'list', 'web').document.items[0].item_id;
  assert.deepEqual(Object.keys(json(box, box.repo, 'show', String(id), '--fields', 'item_id,item_status').document), ['version', 'item_id', 'item_status']);
  const listed = json(box, box.repo, 'list', 'web', '--fields', 'item_id').document;
  assert.deepEqual(Object.keys(listed), ['version', 'items']);
  assert.deepEqual(listed.items, [{ item_id: id }]);
  const queue = json(box, box.repo, 'queue', '--fields', 'id').document;
  assert.ok(queue.unreleased.length > 0 && queue.unreleased.every(row => Object.keys(row).join() === 'id'), 'queue rows carry only id');
  const inbox = json(box, box.web, 'inbox', '--fields=shout_id').document;
  assert.ok(inbox.shouts.length > 0 && inbox.shouts.every(row => Object.keys(row).join() === 'shout_id'), 'inbox rows carry only shout_id');
  const refusal = json(box, box.repo, 'show', '999999', '--fields', 'item_id').document;
  assert.equal(refusal.error.code, 'NO_ITEM', 'a refusal keeps its code and next step');
});

test('selectFields keeps a named cursor beside trimmed rows and drops lists that carry none of the keys [N2]', () => {
  const document = { version: 1, shouts: [{ shout_id: 4, shout_text: 'x' }], next: 4, more: false, budget: { limit: 1 }, thread: [{ kind: 'a' }] };
  assert.deepEqual(selectFields(document, ['shout_id', 'next']), { version: 1, shouts: [{ shout_id: 4 }], next: 4 });
});

test('a history row larger than the whole budget is cut to fit and marked, so no reply exceeds the budget [N2,A1]', () => {
  const box = helpers.project('true');
  const configPath = join(box.web, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  writeFileSync(configPath, JSON.stringify({ ...config, inbox: { tokenBudget: 1024 } }));
  // @pullboard-board-file journey: the real CLI subprocess reads this oversized multibyte shout from the project board.
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try { store.shout(board, { from: 'coordinator', to: 'web-1', text: 'historical ' + '界'.repeat(380), lanes: ['web'] }); }
  finally { store.closeBoard(board); }
  const text = box.run(box.web, 'inbox', '--history', '--since', '0');
  assert.equal(text.code, 0, text.err);
  assert.ok(Buffer.byteLength(text.out) <= 1024, `text reply is ${Buffer.byteLength(text.out)} bytes`);
  const reply = box.run(box.web, 'inbox', '--history', '--since', '0', '--json');
  assert.ok(Buffer.byteLength(reply.out) <= 1024, `JSON reply is ${Buffer.byteLength(reply.out)} bytes`);
  const row = JSON.parse(reply.out).shouts.find(shout => shout.shout_text.startsWith('historical'));
  assert.equal(row.shout_text_cut, true, 'the oversized row says it was cut');
  assert.match(row.shout_text, /cut to fit the inbox budget\)$/u);
});
