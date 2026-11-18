/** landingOfferBatches cuts one offer's free items into jobs: sliced by size as before, or one job per item of the first parallel start group [C7,#9836]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { landingOfferBatches } from '../../../src/io/landing/pull.js';
import { mechanicalConflictFiles } from '../../../../../packages/merge/index.js';
import { mechanicalOnlyConflictRepo } from '../../fixtures/landing/conflict-repos.js';
import { realConflictRepo } from '../../fixtures/landing/conflict-repos.js';
import { underBoardWriteLock } from '../../../src/io/landing/pull.js';
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
