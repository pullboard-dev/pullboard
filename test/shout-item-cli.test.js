/** Literal item-message text survives ordinary recipient words [B7,A2,N19]. */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { join } from 'node:path';
import * as store from '../src/board.js';
import { openBoard } from '../src/native-board.js';
import { moveArgs } from '../packages/person/index.js';
import { createE2eHelpers } from './e2e-helpers.js';

const fixtures = createE2eHelpers();
after(fixtures.cleanup);

test('an explicit item keeps all, person and lane names as literal message text [B7,A2,N19]', () => {
  const box = fixtures.project('true');
  const added = box.run(box.repo, 'add', 'web', 'Literal item messages', '--specs', 'G1', '--criterion', 'item messages retain text');
  assert.equal(added.code, 0, added.err);
  for (const text of ['all', 'person', 'web']) {
    const sent = box.run(box.web, 'shout', '--item', '1', text, '--json');
    assert.equal(sent.code, 0, `${text}: ${sent.err}${sent.out}`);
    const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
    try {
      const row = store.getShout(board, JSON.parse(sent.out).id);
      assert.equal(row.shout_to, 'item:1');
      assert.equal(row.shout_text, text);
    } finally { store.closeBoard(board); }
  }
  const explicit = box.run(box.web, 'shout', 'web', 'explicit recipient with item', '--item', '1', '--json');
  assert.equal(explicit.code, 0, explicit.err);
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    const row = store.getShout(board, JSON.parse(explicit.out).id);
    assert.equal(row.shout_to, 'item:1');
    assert.equal(row.shout_text, 'explicit recipient with item');
  } finally { store.closeBoard(board); }
});


test('explicit news follows normal CLI and API argument authority [R2,N26,H16,A2]', () => {
  const box = fixtures.project('true');
  const text = 'A private release belongs in the session-start digest.';
  const argv = moveArgs({ verb: 'shout', args: { to: 'all', text, news: true } });
  assert.deepEqual(argv, ['shout', '--news', '--json', '--', 'all', text], 'API news uses the normal literal CLI flag');
  const sent = box.run(box.repo, ...argv);
  assert.equal(sent.code, 0, sent.err || sent.out);
  const id = JSON.parse(sent.out).id;
  const inbox = box.run(box.web, 'inbox', '--json');
  assert.equal(inbox.code, 0, inbox.err || inbox.out);
  const delivered = JSON.parse(inbox.out);
  assert.equal(delivered.shouts.some(shout => shout.shout_id === id), false, 'news is not delivered twice as an ordinary message');
  assert.deepEqual(delivered.activity.digests.find(digest => digest.kind === 'news')?.shouts, [id]);
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    assert.ok(store.events(board).some(event => event.event_kind === 'shout_news'
      && JSON.parse(event.event_detail).shout === id), 'the real CLI records news with its distinct native kind');
    const before = store.events(board);
    for (const [root, args] of [[box.web, ['shout', 'all', 'An agent cannot hide a broadcast', '--news', '--json']],
      [box.repo, ['shout', 'all', 'A decision is not expendable news', '--news', '--decision', '--json']]]) {
      const refused = box.run(root, ...args);
      assert.notEqual(refused.code, 0, refused.err || refused.out);
      assert.equal(JSON.parse(refused.out).error?.code, 'BAD_NEWS', refused.err || refused.out);
      assert.deepEqual(store.events(board), before, 'refused news appends no native event');
    }
  } finally { store.closeBoard(board); }
});
