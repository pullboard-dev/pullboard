/** @pullboard-module-loads packages/git/src/io/main.js packages/moves/src/io/selection.js */
/** next re-joins a seat to the lane with work only when the seat holds no live claim and its lane owns folders [N2,C7,#10691], and warms from the seat's three latest built items with one bounded read [N2,C7,#10692]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { recordSubmitHandoff } from '../../../jobs/index.js';
import * as store from '../../../store/index.js';
import { cellSeat } from '../../../store/tests/fixtures/cell.js';
import { nextSelection } from '../../index.js';
import { warmFiles } from '../../src/io/selection.js';
import { fixture } from '../fixtures/next.js';

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

/** Count the git status launches made while `work` runs, by wrapping the child_process entry points Git calls go through. */
function countingStatus(work) {
  const childProcess = createRequire(import.meta.url)('node:child_process');
  const wrapped = ['execFileSync', 'spawnSync', 'execFile', 'spawn'], original = Object.fromEntries(wrapped.map(name => [name, childProcess[name]]));
  let statuses = 0;
  for (const name of wrapped) childProcess[name] = (...args) => { if (Array.isArray(args[1]) && args[1].includes('status')) statuses++; return original[name](...args); };
  syncBuiltinESMExports();
  try { return { value: work(), statuses: () => statuses }; } finally { Object.assign(childProcess, original); syncBuiltinESMExports(); }
}

/** Point the machine home at a folder inside the fixture project, so the status cache of a test never reaches the machine's own. */
function privateMachineHome(t, box) {
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(box.project.dir, 'machine-home');
  t.after(() => { if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previous; });
}

test('moves.selection.status-reused: clause 1: two nextSelection.pick calls on an unchanged seat checkout launch git status at most once between them, with the same warm files [N2,C7,#10859]', t => {
  const box = fixture(t);
  privateMachineHome(t, box);
  box.add('Open work for the pick');
  const first = countingStatus(() => nextSelection.pick(box.ctx, box.board, { defaultLoop: true, observeIdle: true, omitIds: [] }, box.ports));
  const warmFirst = warmFiles(box.ctx, box.board, box.seats.actor, box.ports);
  const second = countingStatus(() => nextSelection.pick(box.ctx, box.board, { defaultLoop: true, observeIdle: true, omitIds: [] }, box.ports));
  const warmSecond = warmFiles(box.ctx, box.board, box.seats.actor, box.ports);
  assert.equal(second.statuses() + 0, 0, 'the second pick on an unchanged checkout launches no git status');
  assert.ok(first.statuses() <= 1, 'the first pick reads the status at most once');
  assert.deepEqual(warmSecond, warmFirst, 'the warm files are the same as the status read gave');
  assert.equal(second.value.item?.item_id, first.value.item?.item_id, 'the second pick selects the same item');
});

test('moves.selection.edit-named-file-warms: clause 2: a first edit to a clean tracked file an open item in the seat lane names is in the second pick warm files, and the pick selects the same item [N2,C7,#10859]', t => {
  const box = fixture(t);
  privateMachineHome(t, box);
  const root = box.project.repo, target = join(root, 'web', 'target.js');
  mkdirSync(join(root, 'web'), { recursive: true });
  writeFileSync(target, 'export const one = 1;\n');
  const gitIn = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args], { cwd: root, stdio: 'pipe' });
  gitIn('add', 'web/target.js');
  gitIn('commit', '-m', 'track target');
  const open = box.add('Open work naming the target', { brief: 'Files: web/target.js\nTest: the real board picks it.' });
  const pick = () => nextSelection.pick(box.ctx, box.board, { defaultLoop: true, observeIdle: true, omitIds: [] }, box.ports);
  const before = pick();
  assert.ok(!warmFiles(box.ctx, box.board, box.seats.actor, box.ports).includes('web/target.js'), 'a clean file is not warm');
  writeFileSync(target, 'export const one = 1;\nexport const two = 2;\n');
  assert.ok(warmFiles(box.ctx, box.board, box.seats.actor, box.ports).includes('web/target.js'), 'the edited file the open item names is warm');
  assert.equal(pick().item?.item_id, before.item?.item_id, 'the pick selects the same item');
  assert.equal(before.item?.item_id, open);
});
