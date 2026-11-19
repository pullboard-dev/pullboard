/** landingOfferBatches cuts one offer's free items into jobs: sliced by size as before, or one job per item of the first parallel start group [C7,#9836]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { landingOfferBatches } from '../../../src/io/landing/pull.js';
import { offerPulledLanding } from '../../../src/io/landing/pull.js';
import { acceptOrderOf } from '../../../src/io/landing/pull.js';
import { sweepDerivedState } from '../../../../../packages/health/index.js';
import { addItem } from '../../../../../packages/store/index.js';
import { mechanicalConflictFiles } from '../../../../../packages/merge/index.js';
import { mechanicalOnlyConflictRepo } from '../../fixtures/landing/conflict-repos.js';
import { realConflictRepo } from '../../fixtures/landing/conflict-repos.js';
import { underBoardWriteLock } from '../../../src/io/landing/pull.js';
import { offerWithLog } from '../../fixtures/landing/offer.js';
import { fixtureBoard } from '../../fixtures/board.js';
import { temporaryDirectory } from '../../fixtures/board.js';

/** Accepted entries in accept order: #1 and #2 are disjoint, #3 shares #1's file, #4 shares #2's test. */
const free = [
  { id: 1, files: ['a.js', 'a.test.js'], tests: ['a.test.js'] },
  { id: 2, files: ['b.js', 'b.test.js'], tests: ['b.test.js'] },
  { id: 3, files: ['a.js'], tests: [] },
  { id: 4, files: ['d.js'], tests: ['b.test.js'] },
];

test('cli.io-landing-pull.parallel-on-offers-group: clause 1: with parallel on, one single-item batch per id of the first start group, so disjoint items are offered together and items sharing a file or test are not [C7,#9836]', () => {
  const batches = landingOfferBatches(free, { size: 4, parallel: true });
  assert.deepEqual(batches.map(batch => batch.map(entry => entry.id)), [[1], [2]]);
  assert.equal(batches[0][0], free[0], 'the entry itself is offered');
  assert.deepEqual(landingOfferBatches([free[0], free[2]], { size: 4, parallel: true }).map(batch => batch[0].id), [1], 'a shared file keeps #3 out');
  assert.deepEqual(landingOfferBatches([free[1], free[3]], { size: 4, parallel: true }).map(batch => batch[0].id), [2], 'a shared test keeps #4 out');
  assert.deepEqual(landingOfferBatches([], { size: 4, parallel: true }), []);
});

test('cli.io-landing-pull.parallel-off-as-today: clause 2: with parallel off, free is cut into batches of size exactly as the slice loop on main does [C7,#9836]', () => {
  assert.deepEqual(landingOfferBatches(free, { size: 3 }).map(batch => batch.map(entry => entry.id)), [[1, 2, 3], [4]]);
  assert.deepEqual(landingOfferBatches(free, { size: 1, parallel: false }).map(batch => batch.map(entry => entry.id)), [[1], [2], [3], [4]]);
  assert.deepEqual(landingOfferBatches(free, { size: 4, parallel: false }).map(batch => batch.length), [4]);
  assert.deepEqual(landingOfferBatches([], { size: 2 }), []);
});

test('cli.io-landing-pull.conflict-repos-mechanical-only: clause 1: the conflict-repos helper builds a mechanical-only conflict [C7,#3064]', () => {
  const { root, main, head } = mechanicalOnlyConflictRepo();
  assert.deepEqual(mechanicalConflictFiles(root, main, head), []);
  assert.deepEqual(mechanicalConflictFiles(root, head, main), []);
});

test('cli.io-landing-pull.conflict-repos-real: clause 2: the conflict-repos helper builds a real conflict [C7,#3064]', () => {
  const { root, main, head, file } = realConflictRepo();
  assert.deepEqual(mechanicalConflictFiles(root, main, head), [file]);
});

/** A real file board whose machine logs go to a private home; returns the board, its holder folder and a reader of board-writes.jsonl. */
function lockedBoard(t) {
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  const home = temporaryDirectory('pullboard-offer-lock-');
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; });
  const board = fixtureBoard(t, { storage: 'file', purpose: 'locking' });
  const file = realpathSync(board.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main').file);
  const holders = () => existsSync(file + '.write-holders') ? readdirSync(file + '.write-holders') : [];
  const rows = () => existsSync(join(home, 'board-writes.jsonl')) ? readFileSync(join(home, 'board-writes.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  return { board, holders, rows };
}

test('cli.io-landing-pull.offer-lock-records-hold: clause 1: an offer through underBoardWriteLock() appends one row to the machine board-writes.jsonl naming its command, pid and outcome [C7,#11027]', t => {
  const { board, rows } = lockedBoard(t);
  assert.equal(underBoardWriteLock(board, () => 'offered'), 'offered');
  const offers = () => rows().filter(row => row.move === 'offerPulledLanding');
  const [row, ...rest] = offers();
  assert.deepEqual(rest, [], 'one row for one offer');
  assert.equal(row.move, 'offerPulledLanding');
  assert.equal(row.pid, process.pid);
  assert.equal(row.outcome, 'committed');
  assert.ok(typeof row.command === 'string' && row.command.length > 0);
  assert.throws(() => underBoardWriteLock(board, () => { throw new Error('refused offer'); }), /refused offer/u);
  assert.deepEqual(offers().map(entry => entry.outcome), ['committed', 'rolled-back']);
});

test('cli.io-landing-pull.offer-lock-marks-holder: clause 2: while the offer holds the lock the board write-holders folder has its marker, and it is gone after commit or rollback [C7,#11027]', t => {
  const { board, holders } = lockedBoard(t);
  let during = [];
  underBoardWriteLock(board, () => { during = holders(); });
  assert.equal(during.length, 1, 'the marker exists while the lock is held');
  assert.ok(during[0].startsWith(`${process.pid}-`));
  assert.deepEqual(holders(), [], 'gone after commit');
  assert.throws(() => underBoardWriteLock(board, () => { throw new Error('refused offer'); }), /refused offer/u);
  assert.deepEqual(holders(), [], 'gone after rollback');
});

test('cli.io-landing-pull.git-outside-offer-lock: clause 1: offerPulledLanding with parallelGates on starts no git child process while its injected board write lock is held [C7,#11105]', async t => {
  const { result, lines, jobs } = await offerWithLog(t);
  const enter = lines.indexOf('LOCK_ENTER'), exit = lines.indexOf('LOCK_EXIT');
  assert.ok(enter >= 0 && exit > enter, `the offer went through the injected lock: ${lines.join(' | ')}`);
  assert.deepEqual(lines.slice(enter, exit).filter(line => line.startsWith('git ')), [], 'no git starts between lock enter and lock exit');
  assert.ok(lines.slice(0, enter).filter(line => line.startsWith('git ')).length > 0, 'the git reads still happen, before the lock');
  assert.equal(jobs.length, 2, 'the offer was written');
  assert.ok(result.offered);
});

test('cli.io-landing-pull.offer-unchanged-outside-lock: clause 2: the offered job carries the same items, files, tests and flakes as when the reads ran inside the lock, and an item a concurrent offer took is still left out [C7,#11105]', async t => {
  const plain = await offerWithLog(t);
  // Disjoint files and tests: parallel gates offer one single-item job per item; each carries its own flakes prefixes.
  assert.deepEqual(plain.jobs.map(job => job.items.map(entry => entry.id)), [[1], [2]]);
  for (const job of plain.jobs) assert.deepEqual(job.flakes, { rerun: true, prefixes: { check: 'prefix', proof: 'prefix' } });
  assert.deepEqual(plain.result.items, [1, 2]);
  const raced = await offerWithLog(t, { concurrentOffer: true });
  // #2 was offered by the concurrent accept before this offer's lock; this offer adds a job for #1 only.
  assert.deepEqual(raced.jobs.map(job => job.items.map(entry => entry.id)).sort(), [[1], [2]]);
  assert.deepEqual(raced.result.items, [1], 'only #1 is left to this offer');
});

test('cli.io-landing-pull.step-aside-head-goes-behind: clause 1: offerPulledLanding offers an accepted item with 2 infrastructure failures behind the next accepted item [C7,#3118]', async t => {
  const { jobs, result } = await offerWithLog(t, { lapses: { 1: 2 } });
  assert.deepEqual(jobs.map(job => job.items.map(entry => entry.id)), [[2], [1]], 'the head with two failures goes behind #2');
  assert.deepEqual(result.items, [2, 1]);
});

test('cli.io-landing-pull.step-aside-one-failure-keeps-order: clause 2: one infrastructure failure keeps the accept-order place, and named ids keep the order named [C7,#3118]', async t => {
  const one = await offerWithLog(t, { lapses: { 1: 1 } });
  assert.deepEqual(one.jobs.map(job => job.items.map(entry => entry.id)), [[1], [2]], 'one failure keeps the place');
  const none = await offerWithLog(t, { lapses: {} });
  assert.deepEqual(none.result.items, [1, 2]);
});

test('cli.io-landing-pull.step-aside-on-the-real-pull-path: clause 3: the step-aside cases drive offerPulledLanding on the real pull path, which reads store.stepAsideCount, not candidates() [C7,#3118]', async t => {
  // A count past 2 also goes behind; the order comes from the offer's written jobs, so the pull path itself applied the rule.
  const { jobs } = await offerWithLog(t, { lapses: { 1: 3 } });
  assert.deepEqual(jobs.map(job => job.items.map(entry => entry.id)), [[2], [1]]);
});

const SWEPT = 'a'.repeat(40);
const MOVED = 'b'.repeat(40);

/** A file board with two accepted unlanded items, #second accepted before #first, swept at SWEPT with a table order the events do not give; returns the board, both ids and the SQL its prepares saw. */
function acceptedBoard(t) {
  const board = fixtureBoard(t, { storage: 'file', purpose: 'persistence' });
  const [first, second] = [1, 2].map(n => addItem(board, { by: 'coordinator', lane: 'web', title: `Accepted item ${n}` }));
  const accept = id => board.db.prepare("INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES ('2026-11-16T00:00:00.000Z', 'fixture', 'accept', ?, '{}')").run(id);
  accept(second);
  accept(first);
  const listItems = () => board.db.prepare('SELECT * FROM item ORDER BY item_id').all().map(item => ({ ...item, item_status: 'verified' }));
  sweepDerivedState(board, { mainCommit: SWEPT, enabled: true, listItems, verdictState: () => null, gateAtHead: () => null });
  const sql = [];
  const prepare = board.db.prepare.bind(board.db);
  board.db.prepare = text => { sql.push(text); return prepare(text); };
  return { board, first, second, sql };
}

test('cli.io-landing-pull.accept-order-from-table: clause 1: with health.derivedState on and a table current for main, the offer orders accepted items by the table accept order and runs no GROUP BY scan of accept events [C7,#11381]', async t => {
  const { board, first, second, sql } = acceptedBoard(t);
  const order = await acceptOrderOf('/unused', board, [first, second], { enabled: true, mainCommit: SWEPT });
  assert.deepEqual([...order.keys()].sort((a, b) => order.get(a) - order.get(b)), [second, first], 'the table orders #2 (accepted first) before #1');
  assert.ok(!sql.some(text => /GROUP BY/i.test(text)), 'no accept-event scan ran');
});

test('cli.io-landing-pull.accept-order-as-on-main: clause 2: with a table swept at an older main, or with the setting off, the offer orders items exactly as on main from the accept events [C7,#11381]', async t => {
  const { board, first, second, sql } = acceptedBoard(t);
  const scanned = [...(await acceptOrderOf('/unused', board, [first, second], { enabled: false })).entries()];
  assert.deepEqual(scanned.sort((a, b) => a[1] - b[1]).map(([id]) => id), [second, first]);
  assert.ok(sql.some(text => /GROUP BY/i.test(text)), 'the setting off scans the events');
  sql.length = 0;
  const stale = [...(await acceptOrderOf('/unused', board, [first, second], { enabled: true, mainCommit: MOVED })).entries()];
  assert.deepEqual(stale.sort((a, b) => a[1] - b[1]), scanned, 'a table swept at an older main is not read');
  assert.ok(sql.some(text => /GROUP BY/i.test(text)), 'the older table scans the events');
});

test('cli.io-landing-pull.accept-order-production-wiring: clause 3: the offer reads acceptOrderOf in place of its accept-event query, and acceptOrderOf reads readDerivedState [C7,#11381]', () => {
  assert.match(offerPulledLanding.toString(), /await acceptOrderOf\(root, board,/);
  assert.doesNotMatch(offerPulledLanding.toString(), /GROUP BY/);
  assert.match(acceptOrderOf.toString(), /readDerivedState\(board, \{ mainCommit: main, enabled: true \}\)/);
});
