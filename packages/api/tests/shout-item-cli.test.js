/** Literal item-message text survives ordinary recipient words [B7,A2,N19]. */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as store from '../../../src/board.js';
import { openBoard } from '../../../src/native-board.js';
import { moveArgs } from '../../person/index.js';
import { derivedFamily } from '../../items/index.js';
import { createE2eHelpers } from '../../../test/e2e-helpers.js';

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

test('an unchanged inbox read takes no board write while another seat holds a claim [R2,N26,B3]', () => {
  const box = fixtures.project('true');
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  for (const [lane, title] of [['web', 'Quiet inbox'], ['api', 'Busy neighbour']]) {
    const added = box.run(box.repo, 'add', lane, title, '--specs', lane === 'web' ? 'G1' : 'G2', '--criterion', 'inbox stays read-only');
    assert.equal(added.code, 0, added.err);
  }
  const neighbour = join(box.dir, 'api-seat');
  box.git(box.repo, 'worktree', 'add', '-q', '-b', 'api/neighbour', neighbour, 'main');
  for (const [root, args] of [[neighbour, ['join', 'api']], [neighbour, ['claim', '2']], [box.web, ['claim', '1']], [box.web, ['inbox']]]) {
    const done = box.run(root, ...args);
    assert.equal(done.code, 0, `${args.join(' ')}: ${done.err}${done.out}`);
  }
  // A held connection's data_version moves whenever any other connection commits a change to the file.
  const watcher = new DatabaseSync(file, { readOnly: true });
  try {
    const version = () => watcher.prepare('PRAGMA data_version').get().data_version;
    const before = version();
    const read = box.run(box.web, 'inbox', '--json');
    assert.equal(read.code, 0, read.err || read.out);
    assert.equal(version(), before, 'a repeat inbox with nothing new commits nothing, not even lapsed-claim maintenance');
    const sent = box.run(box.repo, 'shout', 'web', 'something new for the web lane');
    assert.equal(sent.code, 0, sent.err);
    const delivered = JSON.parse(box.run(box.web, 'inbox', '--json').out);
    assert.ok(delivered.shouts.some(shout => shout.shout_text === 'something new for the web lane'), 'new shouts are still delivered');
  } finally { watcher.close(); }
});

test('a seat whose session spans many seats derives its family without a per-seat event scan [R2,N26]', () => {
  const box = fixtures.project('true');
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    const seat = store.agentAt(board, box.web).agent_id;
    const family = derivedFamily(board, seat);
    const session = `fixture-session-${seat}`;
    const meta = board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value');
    meta.run(`agent_session:${seat}`, session);
    for (let peer = 0; peer < 40; peer++) meta.run(`agent_session:fixture-peer-${peer}`, session);
    const prepared = [];
    const prepare = board.db.prepare.bind(board.db);
    board.db.prepare = sql => { prepared.push(sql); return prepare(sql); };
    try { assert.equal(derivedFamily(board, seat), family, 'peers with no family records leave the derived family unchanged'); }
    finally { delete board.db.prepare; }
    assert.deepEqual(prepared.filter(sql => /event_by=\?/u.test(sql)), [], 'no query reads one seat\'s events at a time');
  } finally { store.closeBoard(board); }
});
