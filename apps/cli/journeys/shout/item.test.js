/** Literal item-message text survives ordinary recipient words [B7,A2,N19]. */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { moveArgs } from '../../../../packages/person/index.js';
import { derivedFamily } from '../../../../packages/items/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

const fixtures = createE2eHelpers();
after(fixtures.cleanup);

test('an explicit item keeps all, person and lane names as literal message text [B7,A2,N19]', () => {
  const box = fixtures.project('true');
  const added = fixtureAdd(box.run, box.repo, 'web', 'Literal item messages', '--specs', 'G1', '--criterion', 'item messages retain text');
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

test('an unchanged inbox read never waits on the board write lock while another seat holds a claim [R2,N26,B3]', () => {
  const box = fixtures.project('true');
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  for (const [lane, title] of [['web', 'Quiet inbox'], ['api', 'Busy neighbour']]) {
    const added = fixtureAdd(box.run, box.repo, lane, title, '--specs', lane === 'web' ? 'G1' : 'G2', '--criterion', 'inbox stays read-only');
    assert.equal(added.code, 0, added.err);
  }
  const neighbour = join(box.dir, 'api-seat');
  box.git(box.repo, 'worktree', 'add', '-q', '-b', 'api/neighbour', neighbour, 'main');
  for (const [root, args] of [[neighbour, ['join', 'api', '--route', 'strong']], [neighbour, ['claim', '2']], [box.web, ['claim', '1']], [box.web, ['inbox']]]) {
    const done = box.run(root, ...args);
    assert.equal(done.code, 0, `${args.join(' ')}: ${done.err}${done.out}`);
  }
  // Another writer holds the board for the whole read: a read that takes no write answers at once instead of
  // queueing behind it for the busy timeout, as every agent's inbox did behind lapsed-claim maintenance (#2421).
  const writer = new DatabaseSync(file);
  try {
    writer.exec('BEGIN IMMEDIATE');
    const started = Date.now();
    const read = box.run(box.web, 'inbox', '--json');
    const waited = Date.now() - started;
    writer.exec('ROLLBACK');
    assert.equal(read.code, 0, read.err || read.out);
    assert.ok(waited < store.BOARD_BUSY_TIMEOUT_MS, `a repeat inbox with nothing new waited ${waited} ms for the board write lock`);
    const sent = box.run(box.repo, 'shout', 'web', 'something new for the web lane');
    assert.equal(sent.code, 0, sent.err);
    const delivered = JSON.parse(box.run(box.web, 'inbox', '--json').out);
    assert.ok(delivered.shouts.some(shout => shout.shout_text === 'something new for the web lane'), 'new shouts are still delivered');
  } finally { writer.close(); }
});

test('a seat whose session spans many seats derives its family without a per-seat event scan [R2,N26]', () => {
  const box = fixtures.project('true');
  // @pullboard-board-file journey: reads the board the CLI children wrote
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

test('a repeat inbox with nothing new never scans the event, shout, seat or metadata tables [R2,N26]', () => {
  const box = fixtures.project('true');
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const added = fixtureAdd(box.run, box.repo, 'web', 'Scan-free inbox', '--specs', 'G1', '--criterion', 'a quiet inbox reads by index');
  assert.equal(added.code, 0, added.err);
  for (const args of [['claim', '1'], ['inbox']]) {
    const done = box.run(box.web, ...args);
    assert.equal(done.code, 0, `${args.join(' ')}: ${done.err}${done.out}`);
  }
  // Record every statement the quiet read prepares, in the real CLI process, then ask SQLite how it would run each.
  const log = join(box.dir, 'inbox-sql.jsonl'), preload = join(box.dir, 'record-sql.mjs');
  writeFileSync(preload, [
    "import { DatabaseSync } from 'node:sqlite'; import { appendFileSync } from 'node:fs';",
    'const prepare = DatabaseSync.prototype.prepare;',
    `DatabaseSync.prototype.prepare = function (sql) { appendFileSync(${JSON.stringify(log)}, JSON.stringify(sql) + '\\n'); return prepare.call(this, sql); };`,
  ].join('\n'));
  const read = box.run(box.web, 'inbox', '--json');
  assert.equal(read.code, 0, read.err || read.out);
  const inherited = box.env.NODE_OPTIONS;
  box.env.NODE_OPTIONS = [inherited, `--import=${pathToFileURL(preload).href}`].filter(Boolean).join(' ');
  const quiet = box.run(box.web, 'inbox', '--json');
  if (inherited === undefined) delete box.env.NODE_OPTIONS; else box.env.NODE_OPTIONS = inherited;
  assert.equal(quiet.code, 0, quiet.err || quiet.out);
  assert.deepEqual(JSON.parse(quiet.out).shouts, [], 'the measured read had nothing new');
  const statements = [...new Set(readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)))]
    .filter(sql => /^\s*(?:SELECT|WITH)\b/iu.test(sql));
  assert.ok(statements.length > 0, 'the preload observed the quiet read');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    // Item rows stay readable: activity interests walk the dependency and file graph of the items on the board.
    const scans = statements.flatMap(sql => {
      let plan;
      // The same process also reads its machine-local sidecars; only statements over the board's own tables count.
      try { plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map(row => row.detail).join(' | '); }
      catch (error) { if (/no such table/u.test(error.message)) return []; throw error; }
      return /\bSCAN (?:event|shout|agent|board_meta)\b/u.test(plan) ? [`${plan} <- ${sql.replace(/\s+/gu, ' ').slice(0, 160)}`] : [];
    });
    assert.deepEqual(scans, [], 'a quiet inbox reads the event log, shouts, seats and metadata only by index');
  } finally { db.close(); }
});
