/** Cell-level real boards for tests that moved here from the store cell, which sits below board and may not open one [C7]. */
import { closeBoard } from '../../index.js';
import { addItem } from '../../../store/index.js';
import { claim } from '../../../store/index.js';
import { register } from '../../../store/index.js';
import { writeBoardMeta } from '../../../store/index.js';
import { submitFixture } from '../../../store/tests/fixtures/submit.js';
import { FIXTURE_MODEL } from '../../../store/tests/fixtures/cell.js';
import { openKitBoard } from './board.js';

export { FIXTURE_MODEL, openKitBoard };

/** Whether tests under packages/ get the in-memory board by default; node --test runs each file as its own process, so its argv names the file. */
const STAND_IN_DEFAULT = /[\\/]packages[\\/]/u.test(process.argv[1] ?? '');

/**
 * In a test under packages/ the board is, by default, the in-memory stand-in (`:memory:`), proved equal to an on-disk board by the contract
 * in packages/board/tests/from-store/board-contract.test.js (#8087), whatever `file` names. A test that needs the file itself, because
 * it starts a process on it, reads it back or watches it on disk, asks with `options.real: true`.
 *
 * @param {import('node:test').TestContext} t
 * @param {string} file - A board.sqlite path, a cellRepo's boardFile, or ':memory:'; only used when `real` is true.
 * @param {{ now: () => Date }} [clock]
 * @param {object} [options] - openBoard options such as gitRoot, plus `real` to open `file` on disk.
 * @returns {object} The open board.
 */
export function cellBoard(t, file, clock, { real = !STAND_IN_DEFAULT, ...options } = {}) {
  const board = openKitBoard(real ? file : ':memory:', clock, options);
  t.after(() => { try { closeBoard(board); } catch { /* A test that closed it itself already released it. */ } });
  return board;
}

/**
 * Open a board the test closes itself, for tests that reopen a file to prove what persisted.
 *
 * @param {string} file
 * @param {{ now: () => Date }} [clock]
 * @param {object} [options] - openBoard options such as gitRoot.
 * @returns {object} The open board.
 */
export function openCellBoard(file, clock, options) {
  return openKitBoard(file, clock, options);
}

export { closeBoard as closeCellBoard };

/**
 * Seed weekly capacity rows on a board file, the way `pullboard capacity` records them: one `capacity.week.<week>` record each.
 * Why: a test of what health says about a worsened week needs weeks whose measures it chooses, which a real run cannot give it.
 *
 * @param {string} file - The board file.
 * @param {{ week: string, at: string }[]} rows - The weekly rows to record.
 * @returns {void}
 */
export function seedCapacityWeeks(file, rows) {
  const board = openKitBoard(file);
  try { for (const row of rows) writeBoardMeta(board.db, `capacity.week.${row.week}`, JSON.stringify({ runs: 1, ...row })); }
  finally { closeBoard(board); }
}

/**
 * Seed a board file with one submitted item whose builder declared a family, and review seats of that family that declared not-same-family.
 * Why: a test of what health says about review supply needs seats and a waiting review without running a gate.
 *
 * @param {string} file - The board file.
 * @param {{ lane: string, family: string, reviewers: number }} shape
 * @returns {number} The submitted item's id.
 */
export function seedLimitedReviewQueue(file, { lane, family, reviewers }) {
  const board = openKitBoard(file);
  try {
    const builder = register(board, { lane, path: '/seeded/builder', route: 'strong', family, model: FIXTURE_MODEL });
    for (let index = 0; index < reviewers; index++) register(board, { lane, path: `/seeded/reviewer-${index}`, route: 'strong', family, model: FIXTURE_MODEL, reviewLimits: ['not-same-family'] });
    const id = addItem(board, { by: 'coordinator', lane, title: 'Seeded review waits', route: 'strong' });
    claim(board, id, { agentId: builder, lane, leaseMs: 3_600_000, freeze: row => ({ text: row.item_title, digest: `digest:${row.item_title}` }) });
    submitFixture(board, id, { agentId: builder, commit: '1'.repeat(40), tree: '1'.repeat(40) });
    return id;
  } finally { closeBoard(board); }
}
