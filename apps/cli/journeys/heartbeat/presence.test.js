/** `pullboard heartbeat` is a liveness ping: presence only, no selection, claim, reservation or board writer [C7,#3001]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import {
  cli,
  fixture,
} from '../../tests/fixtures/next/take.js';

/** Read the board's own all-writes log, the record of every write transaction and how long it held the writer. */
function boardWrites() {
  const file = join(process.env.PULLBOARD_MACHINE_HOME, 'board-writes.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}

test('a heartbeat records presence and never selects, claims or reserves a review [C7,#3001]', async t => {
  const box = await fixture(t);
  const build = box.add('A free build a heartbeat must leave alone');
  const review = box.add('A submission a heartbeat must not reserve');
  box.submit(review);
  const events = store.events(box.board).length;
  const beat = await cli(box, box.seats.actor.path, ['heartbeat']);
  assert.equal(beat.code, 0, beat.out + beat.err);
  assert.equal(Object.hasOwn(beat.document, 'work'), false, 'the result carries presence only, no work');
  assert.equal(beat.document.seat, box.seats.actor.id);
  assert.equal(beat.document.presence, 'live');
  assert.ok(Number.isFinite(Date.parse(beat.document.heartbeatAt)), 'the local presence observation is recorded');
  assert.equal(store.getItem(box.board, build).item_owner, null, 'no build claim');
  assert.equal(store.getItem(box.board, build).item_status, 'open');
  assert.equal(store.getItem(box.board, review).item_review_by, null, 'no review reservation');
  assert.equal(store.events(box.board).length, events, 'no board move of any kind');
  const hook = await cli(box, box.seats.actor.path, ['hook', 'Stop']);
  assert.equal(hook.code, 0, hook.out + hook.err);
  assert.equal(store.getItem(box.board, build).item_owner, null, 'the Stop hook claims nothing either');
  assert.equal(store.getItem(box.board, review).item_review_by, null);
  const taken = await cli(box, box.seats.actor.path, ['next', '--take']);
  assert.equal(taken.code, 0, taken.out + taken.err);
  assert.ok([build, review].includes(taken.document.item.item_id), 'the work was eligible: only next --take takes it');
});

test('a heartbeat holds the board writer under 5 ms, by taking no write transaction at all [C7,#3001]', async t => {
  const box = await fixture(t);
  box.add('Eligible work that once made heartbeat claim under the write lock');
  const before = boardWrites().length;
  for (let beat = 0; beat < 3; beat += 1) {
    const result = await cli(box, box.seats.actor.path, ['heartbeat']);
    assert.equal(result.code, 0, result.out + result.err);
    box.advance(120_000);
  }
  const held = boardWrites().slice(before);
  assert.ok(held.every(row => row.heldMs < 5), `writer held ${JSON.stringify(held.map(row => row.heldMs))} ms`);
  assert.deepEqual(held, [], 'heartbeat writes only its private sidecar, never the board');
});

const SEATS = 1_900;

/** Seed SEATS joined seats; every fifth also has a family event, and pairs share a session. */
function seed(owner) {
  const board = owner.board ?? owner;
  const meta = board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?)');
  const seat = board.db.prepare('INSERT INTO agent(agent_id,agent_lane,agent_path,agent_family,agent_created_at) VALUES(?,?,?,?,?)');
  const event = board.db.prepare('INSERT INTO event(event_at,event_by,event_kind,event_detail) VALUES(?,?,?,?)');
  board.db.exec('BEGIN');
  for (let n = 0; n < SEATS; n++) {
    seat.run(`core-${n}`, 'core', `/fixture/core-${n}`, null, '2026-11-04T00:00:00Z');
    meta.run(`agent_session:core-${n}`, `session-${n >> 1}`);
    event.run('2026-11-04T00:00:00Z', `core-${n}`, 'join', JSON.stringify(n % 3 ? {} : { family: n % 2 ? 'OpenAI' : 'Claude' }));
    if (n % 5 === 0) event.run('2026-11-04T00:00:01Z', `core-${n}`, 'family', JSON.stringify({ family: 'Gemini' }));
  }
  board.db.exec('COMMIT');
}

/** Count prepared statements that read the event table while the real command parser runs, across every database handle it opens. */
async function eventQueries(work) {
  const { DatabaseSync } = await import('node:sqlite');
  const original = DatabaseSync.prototype.prepare;
  let count = 0;
  DatabaseSync.prototype.prepare = function (sql, ...rest) { if (/\bevent\b/iu.test(String(sql))) count += 1; return original.call(this, sql, ...rest); };
  try { await work(); } finally { DatabaseSync.prototype.prepare = original; }
  return count;
}

test('clause 1: the real inbox, status and heartbeat commands on 1,900 agent rows read families from one snapshot, not an event query per seat [C7,#3251]', async t => {
  const box = await fixture(t);
  seed(box);
  for (const args of [['inbox'], ['status'], ['heartbeat']]) {
    const queries = await eventQueries(async () => {
      const result = await cli(box, box.seats.actor.path, args);
      assert.equal(result.code, 0, `${args[0]}: ${result.out}${result.err}`);
    });
    assert.ok(queries < 60, `${args[0]} prepared ${queries} event statements for ${SEATS} seats; one per seat would be over ${SEATS}`);
  }
});
