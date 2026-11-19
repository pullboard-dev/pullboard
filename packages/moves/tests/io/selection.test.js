/** next re-joins a seat to the lane with work only when the seat holds no live claim and its lane owns folders [N2,C7,#10691], and warms from the seat's three latest built items with one bounded read [N2,C7,#10692]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { recordSubmitHandoff } from '../../../jobs/index.js';
import * as store from '../../../store/index.js';
import { cellSeat } from '../../../store/tests/fixtures/cell.js';
import { nextSelection } from '../../index.js';
import { actorClaims } from '../fixtures/next.js';
import { fixture } from '../fixtures/next.js';
import { next } from '../fixtures/next.js';
import { Refused } from '../../../kernel/index.js';

/** view and docs own folders, as in pullboard.json; tests owns none, as the verifier lane does. */
const LANES = { view: { owns: ['apps/view/'] }, docs: { owns: ['guides/'] }, tests: { owns: [] } };

/** A real board with one seat in `lane` running next from its own linked worktree, as a builder seat does. */
function board(t, lane) {
  const box = fixture(t, { lanes: LANES });
  const path = join(box.project.dir, `${lane}-seat`);
  mkdirSync(path);
  const seat = cellSeat(box.board, { lane, path, family: 'Family Alpha' });
  store.heartbeatSeat(box.board, seat.id);
  box.as(seat);
  // The fixture repo is a main checkout; a seat runs next from a linked worktree, where other lanes are looked at.
  const ctx = { ...box.ctx, info: { ...box.ctx.info, isMain: false } };
  const pick = () => nextSelection.pick(ctx, box.board, { defaultLoop: true, observeIdle: true }, box.ports);
  const work = (title, workLane) => box.add(title, { lane: workLane, brief: `Files: ${LANES[workLane].owns[0]}dispatch.js\nTest: the real board picks it.` });
  return { box, seat, pick, work, laneNow: () => store.agentById(box.board, seat.id).agent_lane };
}

test('moves.selection.no-move-while-holding: clause 1: a view seat holding a live claim, with open work only in docs, gets no move and stays in view [N2,C7]', (t) => {
  const { box, seat, pick, work, laneNow } = board(t, 'view');
  const held = work('View work this seat holds', 'view');
  box.claim(held, seat);
  // Submitted with its gate queued: the claim and its view/item folder stay the seat's, but next offers new work (#3532).
  recordSubmitHandoff(box.board.db, held, { version: 1, id: `job-${held}`, agentId: seat.id, commit: 'c'.repeat(40),
    digest: store.getItem(box.board, held).item_frozen_digest, state: 'queued' });
  const docs = work('Docs work', 'docs');
  const looked = pick();
  assert.equal(looked.move, undefined, JSON.stringify(looked));
  assert.deepEqual(looked.otherLane, { item: docs, lane: 'docs' }, 'the docs work is named, not claimed');
  assert.equal(laneNow(), 'view');
  assert.equal(store.getItem(box.board, docs).item_status, 'open');
  assert.equal(store.getItem(box.board, held).item_owner, seat.id, 'the seat still holds the claim');
});

test('moves.selection.no-move-from-folderless-lane: clause 2: a seat in a lane that owns no paths, with build work only in docs, gets no move [N2,C7]', (t) => {
  const { box, pick, work, laneNow } = board(t, 'tests');
  const docs = work('Docs work', 'docs');
  const looked = pick();
  assert.equal(looked.move, undefined, JSON.stringify(looked));
  assert.deepEqual(looked.otherLane, { item: docs, lane: 'docs' });
  assert.equal(laneNow(), 'tests');
  assert.equal(store.getItem(box.board, docs).item_status, 'open');
});

test('moves.selection.idle-seat-still-moves: clause 3: a view seat holding nothing still moves to docs, the lane with work [N2,C7]', (t) => {
  const { pick, work } = board(t, 'view');
  const docs = work('Docs work', 'docs');
  assert.deepEqual(pick().move, { from: 'view', lane: 'docs', item: docs });
});

/** Seed closed built items as a long-running board holds them: filed open with a builder, withdrawn by the coordinator, each keeping its own last update. */
function seedBuilt(box) {
  const insert = box.board.db.prepare(`INSERT INTO item (item_lane, item_title, item_criterion, item_route, item_built_by, item_files,
    item_created_by, item_created_at, item_updated_at) VALUES ('web', ?, 'The real fixture succeeds.', 'mid', ?, ?, 'coordinator', '2026-10-01T00:00:00.000Z', ?)`);
  const row = (title, builder, file, updated) => Number(insert.run(title, builder, file, updated).lastInsertRowid);
  // 50 closed items built by another seat, many updated after this seat's own items.
  for (let n = 0; n < 50; n++) row(`Closed by another seat ${n}`, box.seats.builder.id, `web/other-${n}.js`, `2026-10-2${n % 5}T0${n % 10}:00:00.000Z`);
  const older = row('Closed by this seat, older', box.seats.actor.id, 'web/older.js', '2026-10-20T00:00:00.000Z');
  const recent = [['web/first.js', '2026-10-22T00:00:00.000Z'], ['web/second.js', '2026-10-23T00:00:00.000Z'], ['web/third.js', '2026-10-24T00:00:00.000Z']]
    .map(([file, updated], n) => ({ id: row(`Closed by this seat, recent ${n}`, box.seats.actor.id, file, updated), file }));
  const stamp = box.board.db.prepare('UPDATE item SET item_updated_at = ? WHERE item_id = ?');
  for (const { item_id: id, item_updated_at: updated } of box.board.db.prepare("SELECT item_id, item_updated_at FROM item WHERE item_title LIKE 'Closed by %'").all()) {
    store.withdraw(box.board, id, { agentId: 'coordinator', reason: 'closed fixture item' });
    stamp.run(updated, id);
  }
  return { older, recent: recent.reverse() };
}

/** Record every statement prepared on the board while `work` runs: its SQL, its arguments and the rows it returned. */
function recorded(board, work) {
  const db = board.db, prepare = db.prepare.bind(db), reads = [];
  db.prepare = sql => {
    const statement = prepare(sql);
    return new Proxy(statement, { get: (target, name) => name === 'all'
      ? (...args) => { const rows = target.all(...args); reads.push({ sql, args, rows }); return rows; }
      : typeof target[name] === 'function' ? target[name].bind(target) : target[name] });
  };
  try { return { value: work(), reads }; } finally { delete db.prepare; }
}

test('moves.selection.warm-files-bounded: clause 1: with 50 closed items by other seats and 3 recent built items by this seat, the warm files nextSelection.pick uses are exactly those 3 items files, read without listing all items [N2,C7,#10692]', t => {
  const box = fixture(t);
  const open = box.add('Open work for the pick');
  const { older, recent } = seedBuilt(box);
  const { value, reads } = recorded(box.board, () => nextSelection.pick(box.ctx, box.board, { defaultLoop: true, observeIdle: true, omitIds: [] }, box.ports));
  assert.equal(value.item?.item_id, open, 'the pick still selects the open item');
  const warm = reads.filter(read => /\bitem_built_by = \?/u.test(read.sql) && read.args[0] === box.seats.actor.id);
  assert.equal(warm.length, 1, 'one bounded read of this seat\'s built items');
  const [read] = warm;
  assert.match(read.sql, /LIMIT 3/u, 'the read is bounded at three items');
  assert.deepEqual(read.rows.map(entry => entry.item_id), recent.map(entry => entry.id), 'the three latest items, newest first');
  assert.ok(!read.rows.some(entry => entry.item_id === older), 'the older fourth item is not warm');
  assert.deepEqual(read.rows.map(entry => entry.item_files), recent.map(entry => entry.file), 'the warm files are exactly those three items\' files');
  // The board holds 50 + 4 built items besides the open one; the warm read returned three rows, not the list.
  assert.equal(read.rows.length, 3);
});

test('moves.selection.derived-gate-port: clause 1: with ports.derivedGateAtHead returning a reader, pick passes it to nextFor, so an item the reader names as gated is not picked and the next free item is [C7,#10881]', t => {
  const box = fixture(t);
  const gated = box.add('Gated by the derived table');
  const free = box.add('Free work');
  const derivedGateAtHead = () => entry => (entry.item_id === gated ? `gate green at ${'a'.repeat(12)}` : undefined);
  const picked = nextSelection.pick(box.ctx, box.board, { defaultLoop: true, observeIdle: true, omitIds: [] }, { ...box.ports, derivedGateAtHead });
  assert.equal(picked.item?.item_id, free, 'the item the reader names as gated is skipped');
  assert.notEqual(picked.item?.item_id, gated);
});

test('moves.selection.derived-gate-port-absent: clause 2: with no port, or a port returning null, pick returns the same item as before and no reader reaches nextFor [C7,#10881]', t => {
  const box = fixture(t);
  const first = box.add('First work');
  box.add('Second work');
  const pick = ports => nextSelection.pick(box.ctx, box.board, { defaultLoop: true, observeIdle: true, omitIds: [] }, ports).item?.item_id;
  assert.equal(pick(box.ports), first, 'no port');
  assert.equal(pick({ ...box.ports, derivedGateAtHead: () => null }), first, 'a port returning null');
});

/** The box's claim port, made to refuse `id` as claim refuses a bar naming paths no lane owns; every other claim goes through. */
function refuseOwnership(box, id) {
  const through = box.ports.claimOrdered;
  box.ports.claimOrdered = (ctx, open, args) => {
    if (args[0] === id) throw new Refused('CROSS_OWNERSHIP', 'the bar names zzz/other.js, which no lane owns, so lane web cannot build it', 'split the item');
    return through(ctx, open, args);
  };
}

test('moves.selection.cross-ownership-passed-over: clause 1: an item whose claim is refused CROSS_OWNERSHIP is passed over, reported once, and the next claimable item is offered [C7,#11862]', async t => {
  const box = fixture(t);
  const refused = box.add('Bar names a path no lane owns');
  const claimable = box.add('Claimable work');
  refuseOwnership(box, refused);
  const found = await next(box);
  assert.equal(found.item?.item_id, claimable);
  assert.equal(store.getItem(box.board, refused).item_status, 'open', 'the refused item stays open');
  const reports = store.itemThread(box.board, refused).filter(entry => entry.type === 'fact' && entry.text.includes('"unbuildableBar"') && entry.text.includes('CROSS_OWNERSHIP'));
  assert.equal(reports.length, 1, 'one coordinator report per bar');
});

test('moves.selection.wait-never-offers-refused: clause 2: with wait above 0, an item whose claim refuses for the calling seat is never returned to it; the seat gets the next claimable item or none [C7,#11862]', async t => {
  const box = fixture(t);
  const refused = box.add('Bar names a path no lane owns');
  refuseOwnership(box, refused);
  const alone = await next(box, { wait: 1 });
  assert.equal(alone.item, undefined, 'a lone refused item is not returned, as an offer or a claim');
  assert.equal(alone.waitingOffer, undefined);
  assert.equal(store.getItem(box.board, refused).item_status, 'open');
  const claimable = box.add('Claimable work');
  const found = await next(box, { wait: 1 });
  assert.equal(found.item?.item_id, claimable);
  assert.equal(found.waitingOffer, undefined);
  assert.equal(store.getItem(box.board, claimable).item_status, 'claimed');
});

test('moves.selection.wait-claims-ready-item: clause 1: nextOnce with values.wait above 0 and a ready open item claims it for the calling seat and returns no waitingOffer [C7,#11846]', async t => {
  const box = fixture(t);
  const ready = box.add('Ready work');
  const found = await next(box, { wait: 1 });
  assert.equal(found.item?.item_id, ready);
  assert.equal(found.waitingOffer, undefined, 'no offer to claim later');
  assert.equal(store.getItem(box.board, ready).item_status, 'claimed');
  assert.deepEqual(actorClaims(box), [ready], 'the claim is the calling seat\'s');
});

test('moves.selection.wait-held-unchanged: clause 2: nextOnce with values.wait above 0 and an item the seat already holds returns the held item and makes no second claim [C7,#11846]', async t => {
  const box = fixture(t);
  const mine = box.add('Work this seat holds');
  box.add('Other ready work');
  await next(box, { wait: 1 });
  assert.deepEqual(actorClaims(box), [mine]);
  const again = await next(box, { wait: 1 });
  assert.equal(again.item?.item_id, mine);
  assert.equal(again.held, true);
  assert.equal(again.waitingOffer, undefined);
  assert.deepEqual(actorClaims(box), [mine], 'no second claim');
});

/** Run pick under `config`, recording the who that reaches the review offer (plain loop) and the default offer (default loop). */
function whoReaching(t, box, config) {
  const seen = [];
  const original = { ...nextSelection };
  nextSelection.reviewOffer = (board, who) => { seen.push(who); return original.reviewOffer(board, who); };
  nextSelection.defaultOffer = (board, who) => { seen.push(who); return original.defaultOffer(board, who); };
  t.after(() => Object.assign(nextSelection, original));
  const ctx = { ...box.ctx, config: { ...box.ctx.config, ...config } };
  box.add('Open work');
  nextSelection.pick(ctx, box.board, { defaultLoop: false, observeIdle: true, omitIds: [] }, box.ports);
  nextSelection.pick(ctx, box.board, { defaultLoop: true, observeIdle: true, omitIds: [] }, box.ports);
  return seen;
}

test('moves.selection.compose-landing-on: clause 1: with slices.composeLanding true in ctx.config, the who handed to the review offer and the default offer carries composeLanding true [C7,#11345]', t => {
  const seen = whoReaching(t, fixture(t), { slices: { composeLanding: true } });
  assert.equal(seen.length, 2, 'both offers were reached');
  for (const who of seen) assert.equal(who.composeLanding, true);
});

test('moves.selection.compose-landing-off: clause 2: with slices.composeLanding unset, the who carries no composeLanding and the offer is unchanged [C7,#11345]', t => {
  for (const config of [{}, { slices: { composeLanding: false } }]) {
    const seen = whoReaching(t, fixture(t), config);
    assert.equal(seen.length, 2, 'both offers were reached');
    for (const who of seen) assert.ok(!who.composeLanding, 'composeLanding is false or absent');
  }
});

test('moves.io-selection.in-flight-never-handed-out: clause 1: nextOnce never returns an item whose gate job is offered or claimed at any head, nor one submitted and awaiting review; an item with none of those is still handed out [C7,#12128]', (t) => {
  const { box, pick, work } = board(t, 'view');
  const inGate = work('View work in another seat gate', 'view');
  const free = work('View work nobody holds', 'view');
  const otherPath = join(box.project.dir, 'view-other');
  mkdirSync(otherPath);
  const other = cellSeat(box.board, { lane: 'view', path: otherPath, family: 'Family Alpha' });
  store.heartbeatSeat(box.board, other.id);
  box.claim(inGate, other);
  recordSubmitHandoff(box.board.db, inGate, { version: 1, id: `job-${inGate}`, agentId: other.id, commit: 'c'.repeat(40),
    digest: store.getItem(box.board, inGate).item_frozen_digest, state: 'queued' });
  // The builder's lease lapses while its gate job waits: the claim must not come back as an offer to another seat.
  box.advance(2 * 3_600_000);
  const looked = pick();
  assert.notEqual(looked.item?.item_id, inGate, JSON.stringify(looked));
  assert.equal(looked.item?.item_id, free, 'an item in no gate and awaiting no review is still handed out');
});
